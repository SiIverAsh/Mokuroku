import { createReadStream, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type Database from 'better-sqlite3';
import { seedCommonConstants } from '../db/constants.js';
import {
  type ActiveDbPointer,
  initArchiveSchema,
  openArchiveDb,
  resolveStandbyArchiveDbPath,
  restorePragmasAfterImport,
  switchActiveArchiveDb
} from '../db/open.js';
import { type ArchiveTableName, detectArchiveTableFiles } from './extract.js';
import {
  type InfoboxParseStats,
  type InfoboxRow,
  createInfoboxStats,
  parseSubjectInfobox
} from './infobox.js';

export const DEFAULT_BATCH_SIZE = 50_000;

export interface ImportArchiveOptions {
  extractDir?: string;
  tables?: Partial<Record<ArchiveTableName, string>>;
  dataDir?: string;
  targetDbPath?: string;
  switchActive?: boolean;
  parseInfobox?: boolean;
  onlyTables?: readonly ArchiveTableName[];
  batchSize?: number;
  dumpMeta?: {
    name?: string;
    updatedAt?: string;
    sha256?: string;
  };
  onProgress?: (table: string, count: number) => void;
}

export interface ImportArchiveResult {
  dbPath: string;
  switched: boolean;
  activePointer: ActiveDbPointer | null;
  rowCounts: Record<string, number>;
  infoboxStats: InfoboxParseStats;
  jsonLineErrors: number;
  durationMs: number;
}

const DROP_ALL_TABLES_SQL = `
DROP TABLE IF EXISTS subject_fts;
DROP TABLE IF EXISTS subject_infobox;
DROP TABLE IF EXISTS subject;
DROP TABLE IF EXISTS episode;
DROP TABLE IF EXISTS character;
DROP TABLE IF EXISTS person;
DROP TABLE IF EXISTS subject_relation;
DROP TABLE IF EXISTS subject_character;
DROP TABLE IF EXISTS subject_person;
DROP TABLE IF EXISTS person_character;
DROP TABLE IF EXISTS person_relation;
DROP TABLE IF EXISTS const_subject_type;
DROP TABLE IF EXISTS const_platform;
DROP TABLE IF EXISTS const_subject_relation;
DROP TABLE IF EXISTS const_subject_staff;
DROP TABLE IF EXISTS const_person_relation;
DROP TABLE IF EXISTS archive_meta;
`;

const POST_IMPORT_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_subject_type_score ON subject(type, score DESC, rank ASC);
CREATE INDEX IF NOT EXISTS idx_subject_type_rank ON subject(type, rank ASC);
CREATE INDEX IF NOT EXISTS idx_subject_type_date ON subject(type, date DESC, platform);
CREATE INDEX IF NOT EXISTS idx_subject_fav_total ON subject(type, fav_total DESC);
CREATE INDEX IF NOT EXISTS idx_infobox_subject_id ON subject_infobox(subject_id, ord);
CREATE INDEX IF NOT EXISTS idx_infobox_key ON subject_infobox(key);
CREATE INDEX IF NOT EXISTS idx_episode_subject_sort ON episode(subject_id, type, sort);
CREATE INDEX IF NOT EXISTS idx_episode_airdate ON episode(airdate);
CREATE INDEX IF NOT EXISTS idx_subject_relation_subject ON subject_relation(subject_id, ord);
CREATE INDEX IF NOT EXISTS idx_subject_relation_related ON subject_relation(related_subject_id);
CREATE INDEX IF NOT EXISTS idx_subject_character_subject ON subject_character(subject_id, type, ord);
CREATE INDEX IF NOT EXISTS idx_subject_person_subject ON subject_person(subject_id, position);
CREATE INDEX IF NOT EXISTS idx_subject_person_person ON subject_person(person_id);
CREATE INDEX IF NOT EXISTS idx_person_character_subject ON person_character(subject_id, character_id);
CREATE INDEX IF NOT EXISTS idx_person_character_person ON person_character(person_id);
CREATE INDEX IF NOT EXISTS idx_person_relation_person ON person_relation(person_type, person_id);
`;

function cleanSqliteFiles(dbPath: string): void {
  if (dbPath === ':memory:') return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${dbPath}${suffix}`;
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
    }
  }
}

async function streamJsonLines(
  filePath: string,
  onRecord: (record: Record<string, unknown>) => void,
  onBadLine: () => void
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        onRecord(parsed);
      }
    } catch {
      onBadLine();
    }
  }
}

function extractTagsText(tags: unknown, metaTags: unknown): string {
  const seen = new Set<string>();
  if (Array.isArray(tags)) {
    for (const item of tags) {
      if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        const t = ((item as { name: string }).name).trim();
        if (t) seen.add(t);
      } else if (typeof item === 'string' && item.trim()) {
        seen.add(item.trim());
      }
    }
  }
  if (Array.isArray(metaTags)) {
    for (const item of metaTags) {
      if (typeof item === 'string' && item.trim()) {
        seen.add(item.trim());
      }
    }
  }
  return Array.from(seen).join(' ');
}

function extractFavorites(fav: unknown): {
  json: string | null;
  total: number;
  doing: number;
  done: number;
  wish: number;
} {
  if (!fav || typeof fav !== 'object') {
    return { json: null, total: 0, doing: 0, done: 0, wish: 0 };
  }
  const f = fav as Record<string, unknown>;
  const wish = Number(f.wish ?? 0) || 0;
  const done = Number(f.done ?? f.collect ?? 0) || 0;
  const doing = Number(f.doing ?? f.do ?? 0) || 0;
  const onHold = Number(f.on_hold ?? 0) || 0;
  const dropped = Number(f.dropped ?? 0) || 0;
  return {
    json: JSON.stringify(fav),
    total: wish + done + doing + onHold + dropped,
    doing,
    done,
    wish
  };
}

export async function importArchiveToSqlite(
  options: ImportArchiveOptions
): Promise<ImportArchiveResult> {
  const startedAt = Date.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const shouldParseInfobox = options.parseInfobox ?? true;

  const tables =
    options.tables ??
    (options.extractDir ? detectArchiveTableFiles(options.extractDir) : {});

  const allowedSet = options.onlyTables ? new Set(options.onlyTables) : null;
  const shouldImport = (t: ArchiveTableName): string | undefined => {
    if (allowedSet && !allowedSet.has(t)) return undefined;
    return tables[t];
  };

  let standbyFile: string | undefined;
  let dbPath: string;
  if (options.targetDbPath) {
    dbPath = options.targetDbPath;
  } else {
    const resolved = resolveStandbyArchiveDbPath(options.dataDir);
    standbyFile = resolved.standbyFile;
    dbPath = resolved.standbyPath;
  }

  const shouldSwitch = options.switchActive ?? !options.targetDbPath;

  // Fresh database file on standby slot so active DB is untouched if anything fails.
  // On Windows, if standby slot is locked by an idle reader (EBUSY/EPERM), allocate a new slot file.
  if (!options.targetDbPath) {
    try {
      cleanSqliteFiles(dbPath);
    } catch {
      const fallbackFile = `mokuroku-${Date.now()}.db`;
      standbyFile = fallbackFile;
      dbPath = resolve(dirname(dbPath), fallbackFile);
    }
  }

  const db = openArchiveDb(dbPath, { importMode: true });
  const rowCounts: Record<string, number> = {};
  const infoboxStats = createInfoboxStats();
  let jsonLineErrors = 0;

  try {
    db.exec(DROP_ALL_TABLES_SQL);
    initArchiveSchema(db);
    seedCommonConstants(db);

    const onBadLine = () => {
      jsonLineErrors += 1;
    };

    // 1. subject (+ subject_infobox)
    const subjectFile = shouldImport('subject');
    if (subjectFile) {
      const insertSubject = db.prepare(`
        INSERT OR REPLACE INTO subject (
          id, type, name, name_cn, infobox, platform, summary, nsfw, date,
          favorite, series, tags, score, score_details, rank, meta_tags,
          aliases, tags_text, fav_total, fav_doing, fav_done, fav_wish
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
      `);
      const insertInfobox = db.prepare(`
        INSERT INTO subject_infobox (subject_id, ord, key, sub_key, value)
        VALUES (?, ?, ?, ?, ?)
      `);

      const flushSubjects = db.transaction(
        (subjectRows: unknown[][], infoboxRows: InfoboxRow[]) => {
          for (const r of subjectRows) {
            insertSubject.run(...r);
          }
          for (const info of infoboxRows) {
            insertInfobox.run(info.subjectId, info.ord, info.key, info.subKey, info.value);
          }
        }
      );

      let subjectBatch: unknown[][] = [];
      let infoboxBatch: InfoboxRow[] = [];
      let subjectCount = 0;
      let infoboxRowCount = 0;

      await streamJsonLines(
        subjectFile,
        (r) => {
          const id = Number(r.id);
          if (!Number.isInteger(id)) return;

          const type = Number(r.type ?? 0) || 0;
          const name = typeof r.name === 'string' ? r.name : '';
          const nameCn = typeof r.name_cn === 'string' ? r.name_cn : '';
          const infobox = typeof r.infobox === 'string' ? r.infobox : null;
          const platform = r.platform !== undefined && r.platform !== null ? Number(r.platform) : null;
          const summary = typeof r.summary === 'string' ? r.summary : null;
          const nsfw = r.nsfw ? 1 : 0;
          const date = typeof r.date === 'string' && r.date.trim() ? r.date.trim() : null;
          const fav = extractFavorites(r.favorite);
          const series = r.series === undefined || r.series === null ? null : r.series ? 1 : 0;
          const tagsJson = Array.isArray(r.tags) ? JSON.stringify(r.tags) : null;
          const score = typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null;
          const scoreDetails =
            r.score_details !== undefined && r.score_details !== null
              ? JSON.stringify(r.score_details)
              : null;
          const rank =
            typeof r.rank === 'number' && Number.isInteger(r.rank) && r.rank > 0 ? r.rank : null;
          const metaTagsJson = Array.isArray(r.meta_tags) ? JSON.stringify(r.meta_tags) : null;
          const tagsText = extractTagsText(r.tags, r.meta_tags);

          let aliasesText = '';
          if (shouldParseInfobox && infobox) {
            const parsed = parseSubjectInfobox(id, infobox, infoboxStats, [name, nameCn]);
            if (parsed.aliases.length > 0) {
              aliasesText = parsed.aliases.join(' / ');
            }
            if (parsed.rows.length > 0) {
              for (const infoRow of parsed.rows) {
                infoboxBatch.push(infoRow);
              }
              infoboxRowCount += parsed.rows.length;
            }
          }

          subjectBatch.push([
            id,
            type,
            name,
            nameCn,
            infobox,
            platform,
            summary,
            nsfw,
            date,
            fav.json,
            series,
            tagsJson,
            score,
            scoreDetails,
            rank,
            metaTagsJson,
            aliasesText,
            tagsText,
            fav.total,
            fav.doing,
            fav.done,
            fav.wish
          ]);
          subjectCount += 1;

          if (subjectBatch.length >= batchSize || infoboxBatch.length >= batchSize * 4) {
            flushSubjects(subjectBatch, infoboxBatch);
            subjectBatch = [];
            infoboxBatch = [];
            options.onProgress?.('subject', subjectCount);
          }
        },
        onBadLine
      );

      if (subjectBatch.length > 0 || infoboxBatch.length > 0) {
        flushSubjects(subjectBatch, infoboxBatch);
        subjectBatch = [];
        infoboxBatch = [];
      }

      rowCounts.subject = subjectCount;
      if (shouldParseInfobox) {
        rowCounts.subject_infobox = infoboxRowCount;
      }
      options.onProgress?.('subject', subjectCount);
    }

    // Helper for generic batch table import
    const importTable = async (
      tableName: ArchiveTableName,
      sql: string,
      mapRow: (r: Record<string, unknown>) => unknown[] | null
    ) => {
      const filePath = shouldImport(tableName);
      if (!filePath) return;

      const stmt = db.prepare(sql);
      const flush = db.transaction((rows: unknown[][]) => {
        for (const row of rows) stmt.run(...row);
      });

      let batch: unknown[][] = [];
      let count = 0;

      await streamJsonLines(
        filePath,
        (r) => {
          const mapped = mapRow(r);
          if (!mapped) return;
          batch.push(mapped);
          count += 1;
          if (batch.length >= batchSize) {
            flush(batch);
            batch = [];
            options.onProgress?.(tableName, count);
          }
        },
        onBadLine
      );

      if (batch.length > 0) {
        flush(batch);
        batch = [];
      }
      rowCounts[tableName] = count;
      options.onProgress?.(tableName, count);
    };

    // 2. episode
    await importTable(
      'episode',
      `INSERT OR REPLACE INTO episode (
        id, subject_id, sort, type, disc, name, name_cn, duration, airdate, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      (r) => {
        const id = Number(r.id);
        const subjectId = Number(r.subject_id);
        if (!Number.isInteger(id) || !Number.isInteger(subjectId)) return null;
        return [
          id,
          subjectId,
          typeof r.sort === 'number' ? r.sort : Number(r.sort ?? 0) || 0,
          Number(r.type ?? 0) || 0,
          Number(r.disc ?? 0) || 0,
          typeof r.name === 'string' ? r.name : '',
          typeof r.name_cn === 'string' ? r.name_cn : '',
          typeof r.duration === 'string' ? r.duration : null,
          typeof r.airdate === 'string' && r.airdate.trim() ? r.airdate.trim() : null,
          typeof r.description === 'string' ? r.description : null
        ];
      }
    );

    // 3. character
    await importTable(
      'character',
      `INSERT OR REPLACE INTO character (
        id, role, name, infobox, summary, comments, collects
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      (r) => {
        const id = Number(r.id);
        if (!Number.isInteger(id)) return null;
        return [
          id,
          r.role != null ? Number(r.role) : null,
          typeof r.name === 'string' ? r.name : '',
          typeof r.infobox === 'string' ? r.infobox : null,
          typeof r.summary === 'string' ? r.summary : null,
          r.comments != null ? Number(r.comments) : null,
          r.collects != null ? Number(r.collects) : null
        ];
      }
    );

    // 4. person
    await importTable(
      'person',
      `INSERT OR REPLACE INTO person (
        id, name, type, career, infobox, summary, comments, collects
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      (r) => {
        const id = Number(r.id);
        if (!Number.isInteger(id)) return null;
        return [
          id,
          typeof r.name === 'string' ? r.name : '',
          r.type != null ? Number(r.type) : null,
          Array.isArray(r.career) ? JSON.stringify(r.career) : null,
          typeof r.infobox === 'string' ? r.infobox : null,
          typeof r.summary === 'string' ? r.summary : null,
          r.comments != null ? Number(r.comments) : null,
          r.collects != null ? Number(r.collects) : null
        ];
      }
    );

    // 5. subject_relations
    await importTable(
      'subject_relations',
      `INSERT INTO subject_relation (
        subject_id, relation_type, related_subject_id, ord
      ) VALUES (?, ?, ?, ?)`,
      (r) => {
        const subjectId = Number(r.subject_id);
        const relatedId = Number(r.related_subject_id);
        if (!Number.isInteger(subjectId) || !Number.isInteger(relatedId)) return null;
        return [
          subjectId,
          Number(r.relation_type ?? 0) || 0,
          relatedId,
          Number(r.order ?? 0) || 0
        ];
      }
    );

    // 6. subject_characters
    await importTable(
      'subject_characters',
      `INSERT INTO subject_character (
        subject_id, character_id, type, ord
      ) VALUES (?, ?, ?, ?)`,
      (r) => {
        const subjectId = Number(r.subject_id);
        const characterId = Number(r.character_id);
        if (!Number.isInteger(subjectId) || !Number.isInteger(characterId)) return null;
        return [
          subjectId,
          characterId,
          Number(r.type ?? 1) || 1,
          Number(r.order ?? 0) || 0
        ];
      }
    );

    // 7. subject_persons (with optional 2025-09 appear_eps)
    await importTable(
      'subject_persons',
      `INSERT INTO subject_person (
        subject_id, person_id, position, appear_eps
      ) VALUES (?, ?, ?, ?)`,
      (r) => {
        const subjectId = Number(r.subject_id);
        const personId = Number(r.person_id);
        if (!Number.isInteger(subjectId) || !Number.isInteger(personId)) return null;
        return [
          subjectId,
          personId,
          Number(r.position ?? 0) || 0,
          typeof r.appear_eps === 'string' ? r.appear_eps : null
        ];
      }
    );

    // 8. person_characters
    await importTable(
      'person_characters',
      `INSERT INTO person_character (
        person_id, subject_id, character_id, type, summary
      ) VALUES (?, ?, ?, ?, ?)`,
      (r) => {
        const personId = Number(r.person_id);
        const subjectId = Number(r.subject_id);
        const characterId = Number(r.character_id);
        if (
          !Number.isInteger(personId) ||
          !Number.isInteger(subjectId) ||
          !Number.isInteger(characterId)
        ) {
          return null;
        }
        return [
          personId,
          subjectId,
          characterId,
          Number(r.type ?? 0) || 0,
          typeof r.summary === 'string' ? r.summary : null
        ];
      }
    );

    // 9. person_relations
    await importTable(
      'person_relations',
      `INSERT INTO person_relation (
        person_type, person_id, related_person_id, relation_type, spoiler, ended
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      (r) => {
        const personId = Number(r.person_id);
        const relatedId = Number(r.related_person_id);
        if (!Number.isInteger(personId) || !Number.isInteger(relatedId)) return null;
        return [
          typeof r.person_type === 'string' ? r.person_type : 'prsn',
          personId,
          relatedId,
          Number(r.relation_type ?? 0) || 0,
          r.spoiler ? 1 : 0,
          r.ended ? 1 : 0
        ];
      }
    );

    // Build all secondary indexes & FTS5 AFTER bulk data insertion (~10x faster)
    options.onProgress?.('indexes', 0);
    db.exec(POST_IMPORT_INDEXES_SQL);

    if ((rowCounts.subject ?? 0) > 0) {
      options.onProgress?.('fts5', 0);
      db.exec(`
        INSERT INTO subject_fts(rowid, name, name_cn, aliases, tags)
        SELECT id, name, name_cn, aliases, tags_text FROM subject;
      `);
      db.exec(`INSERT INTO subject_fts(subject_fts) VALUES('optimize');`);
      options.onProgress?.('fts5', rowCounts.subject);
    }

    // Persist import metadata inside the DB itself
    const saveMeta = db.prepare('INSERT OR REPLACE INTO archive_meta (key, value) VALUES (?, ?)');
    const importedAt = new Date().toISOString();
    saveMeta.run('imported_at', importedAt);
    saveMeta.run('row_counts', JSON.stringify(rowCounts));
    saveMeta.run('infobox_failures', String(infoboxStats.failed));
    if (options.dumpMeta?.name) saveMeta.run('dump_name', options.dumpMeta.name);
    if (options.dumpMeta?.updatedAt) saveMeta.run('dump_updated_at', options.dumpMeta.updatedAt);
    if (options.dumpMeta?.sha256) saveMeta.run('dump_sha256', options.dumpMeta.sha256);

    // Sanity check before atomic switch
    validateImportedDb(db, Boolean(subjectFile));

    restorePragmasAfterImport(db);
    db.close();

    let activePointer: ActiveDbPointer | null = null;
    if (shouldSwitch && standbyFile) {
      activePointer = switchActiveArchiveDb(
        {
          activeFile: standbyFile,
          updatedAt: importedAt,
          dumpName: options.dumpMeta?.name,
          dumpUpdatedAt: options.dumpMeta?.updatedAt,
          sha256: options.dumpMeta?.sha256,
          rowCounts,
          infoboxFailures: infoboxStats.failed
        },
        options.dataDir
      );
    }

    return {
      dbPath,
      switched: Boolean(activePointer),
      activePointer,
      rowCounts,
      infoboxStats,
      jsonLineErrors,
      durationMs: Date.now() - startedAt
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore close error
    }
    throw err;
  }
}

function validateImportedDb(db: Database.Database, expectSubjects: boolean): void {
  if (!expectSubjects) return;
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM subject').get() as { cnt: number };
  if (!row || row.cnt <= 0) {
    throw new Error('导入后校验失败: subject 表为空，拒绝切换生产库');
  }
}
