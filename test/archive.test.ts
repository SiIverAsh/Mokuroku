import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ZipSlipError,
  detectArchiveTableFiles,
  extractArchiveZip,
  resolveSafeExtractPath
} from '../src/archive/extract.js';
import { Sha256MismatchError, downloadArchive } from '../src/archive/fetch.js';
import { syncArchivePipeline } from '../src/archive/sync.js';
import { readActivePointer } from '../src/db/open.js';
import { buildTestZipBuffer } from './helpers/zip.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('archive fetch + sha256 + resumable download (offline MSW)', () => {
  it('downloads archive, resumes from .part via HTTP Range, and verifies streaming sha256', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mokuroku-fetch-'));
    try {
      const zipBuf = buildTestZipBuffer([
        { fileName: 'subject.jsonlines', content: '{"id":1,"type":2,"name":"Test"}\n' }
      ]);
      const sha256 = createHash('sha256').update(zipBuf).digest('hex');

      // Simulate existing partial download of first 40 bytes
      const partBytes = zipBuf.subarray(0, 40);
      writeFileSync(join(tempRoot, 'dump-test.zip.part'), partBytes);
      writeFileSync(
        join(tempRoot, 'dump-test.zip.part.json'),
        JSON.stringify({ sha256, size: zipBuf.length, updated_at: '2026-11-10T21:04:27Z' })
      );

      let receivedRangeHeader: string | null = null;

      server.use(
        http.get('https://mock.bgm.local/latest.json', ({ request }) => {
          expect(request.headers.get('user-agent')).toBe('tianchu/mokuroku');
          return HttpResponse.json({
            name: 'dump-test.zip',
            browser_download_url: 'https://mock.bgm.local/dump-test.zip',
            size: zipBuf.length,
            digest: `sha256:${sha256}`,
            updated_at: '2026-11-10T21:04:27Z'
          });
        }),
        http.get('https://mock.bgm.local/dump-test.zip', ({ request }) => {
          receivedRangeHeader = request.headers.get('range');
          if (receivedRangeHeader === 'bytes=40-') {
            const rest = zipBuf.subarray(40);
            return new HttpResponse(new Uint8Array(rest), {
              status: 206,
              headers: {
                'Content-Type': 'application/zip',
                'Content-Length': String(rest.length),
                'Content-Range': `bytes 40-${zipBuf.length - 1}/${zipBuf.length}`
              }
            });
          }
          return new HttpResponse(new Uint8Array(zipBuf), { status: 200 });
        })
      );

      const result = await downloadArchive({
        latestJsonUrl: 'https://mock.bgm.local/latest.json',
        destDir: tempRoot,
        allowApiFallback: false
      });

      expect(receivedRangeHeader).toBe('bytes=40-');
      expect(result.resumed).toBe(true);
      expect(result.sha256).toBe(sha256);
      expect(existsSync(result.zipPath)).toBe(true);
      expect(readFileSync(result.zipPath).equals(zipBuf)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects corrupted archive with Sha256MismatchError and cleans up .part', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mokuroku-badhash-'));
    try {
      const payload = Buffer.from('corrupted-zip-bytes', 'utf8');
      const fakeDigest = 'a'.repeat(64);

      server.use(
        http.get('https://mock.bgm.local/latest.json', () =>
          HttpResponse.json({
            name: 'bad.zip',
            browser_download_url: 'https://mock.bgm.local/bad.zip',
            size: payload.length,
            digest: `sha256:${fakeDigest}`,
            updated_at: '2026-11-10T21:04:27Z'
          })
        ),
        http.get('https://mock.bgm.local/bad.zip', () => new HttpResponse(new Uint8Array(payload)))
      );

      await expect(
        downloadArchive({
          latestJsonUrl: 'https://mock.bgm.local/latest.json',
          destDir: tempRoot,
          allowApiFallback: false,
          maxRetries: 0
        })
      ).rejects.toBeInstanceOf(Sha256MismatchError);

      expect(existsSync(join(tempRoot, 'bad.zip'))).toBe(false);
      expect(existsSync(join(tempRoot, 'bad.zip.part'))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('archive extract + zip slip protection + filename variant probing', () => {
  it('blocks .. traversal, absolute paths, and drive-prefixed paths', () => {
    const dest = join(tmpdir(), 'mokuroku-safe-root');
    expect(() => resolveSafeExtractPath(dest, '../evil.txt')).toThrow(ZipSlipError);
    expect(() => resolveSafeExtractPath(dest, 'nested/../../evil.txt')).toThrow(ZipSlipError);
    expect(() => resolveSafeExtractPath(dest, '/etc/passwd')).toThrow(ZipSlipError);
    expect(() => resolveSafeExtractPath(dest, '\\Windows\\System32\\cmd.exe')).toThrow(
      ZipSlipError
    );
    expect(() => resolveSafeExtractPath(dest, 'C:\\evil.dll')).toThrow(ZipSlipError);

    const valid = resolveSafeExtractPath(dest, 'dump/subject.jsonlines');
    expect(valid.startsWith(dest)).toBe(true);
  });

  it('aborts extraction when zip contains a zip-slip entry', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mokuroku-zipslip-'));
    try {
      const maliciousZip = buildTestZipBuffer([
        { fileName: '../../escaped.txt', content: 'pwned' }
      ]);
      const zipPath = join(tempRoot, 'malicious.zip');
      writeFileSync(zipPath, maliciousZip);

      await expect(
        extractArchiveZip({ zipPath, destDir: join(tempRoot, 'out') })
      ).rejects.toBeInstanceOf(ZipSlipError);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('detects .jsonlines > .jsonl > .json priority and hyphen/underscore variants', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mokuroku-variants-'));
    try {
      const zipBuf = buildTestZipBuffer([
        { fileName: 'subject.json', content: '{"id":1}\n' },
        { fileName: 'subject.jsonl', content: '{"id":2}\n' },
        { fileName: 'subject.jsonlines', content: '{"id":3}\n' },
        { fileName: 'episode.jsonl', content: '{"id":10,"subject_id":3}\n' },
        {
          fileName: 'subject_relations.json',
          content: '{"subject_id":3,"related_subject_id":1,"relation_type":1}\n'
        },
        {
          fileName: 'person-characters.jsonl',
          content: '{"person_id":1,"subject_id":3,"character_id":2}\n'
        }
      ]);
      const zipPath = join(tempRoot, 'variants.zip');
      const outDir = join(tempRoot, 'extracted');
      writeFileSync(zipPath, zipBuf);

      const res = await extractArchiveZip({ zipPath, destDir: outDir });
      expect(res.tables.subject?.endsWith('subject.jsonlines')).toBe(true);
      expect(res.tables.episode?.endsWith('episode.jsonl')).toBe(true);
      expect(res.tables.subject_relations?.endsWith('subject_relations.json')).toBe(true);
      expect(res.tables.person_characters?.endsWith('person-characters.jsonl')).toBe(true);

      const reDetected = detectArchiveTableFiles(outDir);
      expect(reDetected).toEqual(res.tables);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('runs syncArchivePipeline end-to-end and cleans up zip + extract directory afterward', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mokuroku-syncpipe-'));
    const dataDir = join(tempRoot, 'data');
    const cacheDir = join(tempRoot, 'cache');
    try {
      const zipBuf = buildTestZipBuffer([
        {
          fileName: 'subject.jsonlines',
          content:
            '{"id":400602,"type":2,"name":"葬送のフリーレン","name_cn":"","infobox":"{{Infobox animanga/TVAnime\\r\\n|中文名= 葬送的芙莉莲\\r\\n}}","score":8.5,"rank":43}\n'
        }
      ]);
      const sha256 = createHash('sha256').update(zipBuf).digest('hex');

      server.use(
        http.get('https://mock.bgm.local/latest.json', () =>
          HttpResponse.json({
            name: 'dump-sync.zip',
            browser_download_url: 'https://mock.bgm.local/dump-sync.zip',
            size: zipBuf.length,
            digest: `sha256:${sha256}`,
            updated_at: '2026-11-10T21:04:27Z'
          })
        ),
        http.get('https://mock.bgm.local/dump-sync.zip', () =>
          new HttpResponse(new Uint8Array(zipBuf), {
            headers: { 'Content-Type': 'application/zip' }
          })
        )
      );

      const syncRes = await syncArchivePipeline({
        dataDir,
        cacheDir,
        latestJsonUrl: 'https://mock.bgm.local/latest.json'
      });

      expect(syncRes.cleanedUp).toBe(true);
      expect(syncRes.importResult?.rowCounts.subject).toBe(1);
      expect(existsSync(join(cacheDir, 'downloads', 'dump-sync.zip'))).toBe(false);
      expect(readActivePointer(dataDir)?.sha256).toBe(sha256);

      // Repeat with skipIfUnchanged: true -> skips re-download/re-import
      const secondRun = await syncArchivePipeline({
        dataDir,
        cacheDir,
        latestJsonUrl: 'https://mock.bgm.local/latest.json',
        skipIfUnchanged: true
      });
      expect(secondRun.skippedUnchanged).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
