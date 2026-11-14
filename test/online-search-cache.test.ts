import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BangumiClient, EnvPersonalTokenProvider } from '../src/api/client.js';
import { clearApiCache, openCollectionDb, readApiCache, writeApiCache } from '../src/db/open.js';
import { extractWikiV0Metadata, searchSubjectsOnline } from '../src/search.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('WikiV0 metadata & online search + bounded TTL cache', () => {
  it('extracts aliases, studio, and episode count from Bangumi WikiV0 infobox array', () => {
    const parsed = extractWikiV0Metadata(
      [
        { key: '中文名', value: '葬送的芙莉莲' },
        {
          key: '别名',
          value: [
            { v: 'Sousou no Frieren' },
            { k: '英文名', v: "Frieren: Beyond Journey's End" },
            { v: '葬送的芙莉蓮' }
          ]
        },
        { key: '动画制作', value: 'MADHOUSE' },
        { key: '话数', value: '28' }
      ],
      ['葬送のフリーレン', '葬送的芙莉莲']
    );

    expect(parsed.aliases).toEqual([
      'Sousou no Frieren',
      "Frieren: Beyond Journey's End",
      '葬送的芙莉蓮'
    ]);
    expect(parsed.studio).toBe('MADHOUSE');
    expect(parsed.epsCount).toBe(28);
  });

  it('searches subjects online via POST /v0/search/subjects, caches results, and falls back to stale cache on outage', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mokuroku-online-search-'));
    const db = openCollectionDb(join(tempDir, 'collection.db'));

    try {
      let apiCalls = 0;
      let shouldFail = false;

      server.use(
        http.post('https://api.bgm.tv/v0/search/subjects', async ({ request }) => {
          expect(request.headers.get('user-agent')).toBe('tianchu/mokuroku');
          apiCalls += 1;
          if (shouldFail) {
            return new HttpResponse('Bad Gateway', { status: 502 });
          }

          const body = (await request.json()) as {
            keyword: string;
            filter?: { type?: number[]; nsfw?: boolean };
          };
          expect(body.keyword).toBe('葬送的芙莉莲');
          expect(body.filter?.type).toEqual([2]);
          expect(body.filter?.nsfw).toBe(false);

          return HttpResponse.json({
            total: 2,
            limit: 25,
            offset: 0,
            data: [
              {
                id: 515759,
                type: 2,
                name: '葬送のフリーレン 第2期',
                name_cn: '葬送的芙莉莲 第二季',
                summary: '第二季',
                nsfw: false,
                platform: 'TV',
                date: '2026-01-16',
                rating: { score: 7.5, rank: 1005 },
                collection: { wish: 15000, collect: 2000, doing: 18000, on_hold: 500, dropped: 200 },
                tags: [{ name: '奇幻', count: 3200 }]
              },
              {
                id: 400602,
                type: 2,
                name: '葬送のフリーレン',
                name_cn: '葬送的芙莉莲',
                summary: '打倒魔王后的勇者一行后日谈。',
                nsfw: false,
                platform: 'TV',
                date: '2023-09-29',
                infobox: [
                  {
                    key: '别名',
                    value: [{ v: 'Sousou no Frieren' }, { v: '葬送的芙莉蓮' }]
                  }
                ],
                rating: { score: 8.5, rank: 43 },
                collection: { wish: 7209, collect: 55818, doing: 11935, on_hold: 2087, dropped: 779 },
                tags: [
                  { name: '治愈', count: 8162 },
                  { name: '奇幻', count: 6486 }
                ],
                meta_tags: ['TV', '奇幻']
              }
            ]
          });
        })
      );

      const client = new BangumiClient({
        tokenProvider: new EnvPersonalTokenProvider(''),
        cacheDb: db,
        minIntervalMs: 0,
        maxRetries: 0
      });

      // 1st call -> hits online API and ranks exact title match #400602 first
      const hits1 = await searchSubjectsOnline(client, '葬送的芙莉莲', { type: 2 });
      expect(apiCalls).toBe(1);
      expect(hits1[0]?.id).toBe(400602);
      expect(hits1[0]?.aliases).toContain('Sousou no Frieren');

      // 2nd call -> served from local SQLite TTL cache with zero extra HTTP call
      const hits2 = await searchSubjectsOnline(client, '葬送的芙莉莲', { type: 2 });
      expect(apiCalls).toBe(1);
      expect(hits2[0]?.id).toBe(400602);

      // Force expire the cache entry, simulate upstream 502 outage -> stale cache fallback still works
      db.prepare('UPDATE api_cache SET expires_at = 1').run();
      shouldFail = true;
      const staleHits = await searchSubjectsOnline(client, '葬送的芙莉莲', { type: 2 });
      expect(apiCalls).toBe(2);
      expect(staleHits[0]?.id).toBe(400602);

      // Clear cache
      const removed = clearApiCache(db);
      expect(removed).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds api_cache rows by LRU cap so local DB stays lightweight', () => {
    const db = openCollectionDb(':memory:');
    try {
      for (let i = 0; i < 15; i++) {
        writeApiCache(db, `k-${i}`, { idx: i }, 60_000, 10);
      }
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM api_cache').get() as { cnt: number };
      expect(row.cnt).toBeLessThanOrEqual(10);
      expect(readApiCache(db, 'k-14')?.value).toEqual({ idx: 14 });
    } finally {
      db.close();
    }
  });
});
