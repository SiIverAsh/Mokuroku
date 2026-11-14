import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importArchiveToSqlite } from '../src/archive/importer.js';
import { createInfoboxStats, parseSubjectInfobox } from '../src/archive/infobox.js';
import {
  SLOT_A_FILENAME,
  SLOT_B_FILENAME,
  openArchiveDb,
  openCollectionDb,
  readActivePointer,
  resolveActiveArchiveDbPath
} from '../src/db/open.js';
import { searchSubjects } from '../src/search.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

describe('infobox wiki parser + fault tolerance', () => {
  it('extracts structured rows and aliases while tolerating syntax errors', () => {
    const stats = createInfoboxStats();

    const good = parseSubjectInfobox(
      400602,
      `{{Infobox animanga/TVAnime\r\n|中文名= 葬送的芙莉莲\r\n|别名={\r\n[Sousou no Frieren]\r\n[英文名|Frieren: Beyond Journey's End]\r\n}\r\n|动画制作= MADHOUSE\r\n}}`,
      stats
    );
    expect(good.ok).toBe(true);
    expect(good.aliases).toContain('葬送的芙莉莲');
    expect(good.aliases).toContain('Sousou no Frieren');
    expect(good.aliases).toContain("Frieren: Beyond Journey's End");
    expect(good.rows.find((r) => r.key === '动画制作')?.value).toBe('MADHOUSE');

    const bad = parseSubjectInfobox(990002, '{{Infobox broken\n|别名={\n[unclosed', stats);
    expect(bad.ok).toBe(false);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
  });
});

describe('importer + dual-DB switch + better_trigram FTS5 search', () => {
  it('imports fixtures, handles missing columns & broken infoboxes, switches DB slots atomically, and preserves collection.db', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mokuroku-db-'));
    try {
      // Seed user collection in separate collection.db BEFORE archive import
      const colDbPath = join(dataDir, 'collection.db');
      const colDb = openCollectionDb(colDbPath);
      colDb
        .prepare(
          `INSERT INTO collection (subject_id, subject_type, type, rate, ep_status, updated_at)
           VALUES (400602, 2, 3, 9, 2, '2026-11-14T00:00:00Z')`
        )
        .run();
      colDb.close();

      // First import -> should land in mokuroku-a.db
      const imp1 = await importArchiveToSqlite({
        extractDir: FIXTURES_DIR,
        dataDir,
        batchSize: 2,
        dumpMeta: { name: 'fixture-v1.zip', sha256: '1'.repeat(64) }
      });

      expect(imp1.switched).toBe(true);
      expect(readActivePointer(dataDir)?.activeFile).toBe(SLOT_A_FILENAME);
      expect(imp1.rowCounts.subject).toBe(6);
      expect(imp1.rowCounts.episode).toBe(3);
      expect(imp1.rowCounts.subject_relations).toBe(1);
      expect(imp1.infoboxStats.failed).toBe(1); // #990002 malformed wiki counted & skipped

      // Second import -> should write to mokuroku-b.db and atomically flip pointer
      const imp2 = await importArchiveToSqlite({
        extractDir: FIXTURES_DIR,
        dataDir,
        dumpMeta: { name: 'fixture-v2.zip', sha256: '2'.repeat(64) }
      });
      expect(imp2.switched).toBe(true);
      expect(readActivePointer(dataDir)?.activeFile).toBe(SLOT_B_FILENAME);

      // Failed import on empty subject file must NOT overwrite active pointer (remains mokuroku-b.db)
      const emptyDir = mkdtempSync(join(tmpdir(), 'mokuroku-empty-'));
      writeFileSync(join(emptyDir, 'subject.jsonlines'), '');
      try {
        await expect(
          importArchiveToSqlite({
            extractDir: emptyDir,
            dataDir
          })
        ).rejects.toThrow(/subject 表为空/);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
      expect(readActivePointer(dataDir)?.activeFile).toBe(SLOT_B_FILENAME);

      // Verify separate collection.db was NOT cleared by two archive imports
      const colDbCheck = openCollectionDb(colDbPath);
      const savedCol = colDbCheck
        .prepare('SELECT subject_id, rate, ep_status FROM collection WHERE subject_id = 400602')
        .get() as { subject_id: number; rate: number; ep_status: number } | undefined;
      expect(savedCol).toEqual({ subject_id: 400602, rate: 9, ep_status: 2 });
      colDbCheck.close();

      // Verify FTS5 search with better_trigram on all 4 hard-checkpoint queries + aliases
      const activeDb = openArchiveDb(resolveActiveArchiveDbPath(dataDir), { readonly: true });
      try {
        // Check legacy missing-column row (#990001) has NULL score/rank without error
        const legacy = activeDb
          .prepare('SELECT score, rank, tags FROM subject WHERE id = 990001')
          .get() as { score: number | null; rank: number | null; tags: string | null };
        expect(legacy).toEqual({ score: null, rank: null, tags: null });

        // Check bangumi/common constants were seeded
        const tvPlatform = activeDb
          .prepare('SELECT name_cn FROM const_platform WHERE subject_type = 2 AND platform_id = 1')
          .get() as { name_cn: string };
        expect(tvPlatform.name_cn).toBe('TV');

        // 1. 葬送のフリーレン
        const hitsJp = searchSubjects(activeDb, '葬送のフリーレン');
        expect(hitsJp[0]?.id).toBe(400602);

        // 2. 葬送的芙莉莲 & 繁體 葬送的芙莉蓮 & 罗马字 Sousou no Frieren (via aliases)
        expect(searchSubjects(activeDb, '葬送的芙莉莲')[0]?.id).toBe(400602);
        expect(searchSubjects(activeDb, '葬送的芙莉蓮')[0]?.id).toBe(400602);
        expect(searchSubjects(activeDb, 'Sousou no Frieren')[0]?.id).toBe(400602);

        // 3. EVA (hit #265 新世紀エヴァンゲリオン via infobox alias even though name_cn is empty!)
        const hitsEva = searchSubjects(activeDb, 'EVA');
        expect(hitsEva[0]?.id).toBe(265);
        expect(hitsEva[0]?.aliases).toContain('新世纪福音战士');

        // 4. 進撃 (2-character CJK query via better_trigram)
        const hitsShingeki = searchSubjects(activeDb, '進撃');
        expect(hitsShingeki[0]?.id).toBe(263750);

        // 5. Special FTS5 operator characters should not throw
        expect(() => searchSubjects(activeDb, 'Re:Zero " director - (test) *')).not.toThrow();
      } finally {
        activeDb.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
