import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthRequiredError,
  BangumiClient,
  EnvPersonalTokenProvider,
  TokenExpiredError
} from '../src/api/client.js';
import { importArchiveToSqlite } from '../src/archive/importer.js';
import {
  openArchiveDb,
  openCollectionDb,
  resolveActiveArchiveDbPath
} from '../src/db/open.js';
import {
  getDashboardData,
  getSubjectDrawerDetail
} from '../src/web/lib/server/dashboard.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Bangumi v0 API client (offline MSW)', () => {
  it('enforces fixed User-Agent tianchu/mokuroku, serializes requests, and backs off on 429', async () => {
    let attempts = 0;
    let currentInFlight = 0;
    let maxInFlight = 0;
    const seenUserAgents: string[] = [];

    server.use(
      http.get('https://api.bgm.tv/calendar', async ({ request }) => {
        seenUserAgents.push(request.headers.get('user-agent') ?? '');
        currentInFlight += 1;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        await new Promise((r) => setTimeout(r, 15));
        currentInFlight -= 1;

        attempts += 1;
        if (attempts === 1) {
          return new HttpResponse('Too Many Requests', {
            status: 429,
            headers: { 'Retry-After': '0' }
          });
        }
        return HttpResponse.json([
          {
            weekday: { en: 'Fri', cn: '星期五', ja: '金曜日', id: 5 },
            items: [{ id: 400602, type: 2, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲' }]
          }
        ]);
      }),
      http.get('https://api.bgm.tv/v0/subjects/400602', async ({ request }) => {
        seenUserAgents.push(request.headers.get('user-agent') ?? '');
        currentInFlight += 1;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        await new Promise((r) => setTimeout(r, 15));
        currentInFlight -= 1;
        return HttpResponse.json({
          id: 400602,
          type: 2,
          name: '葬送のフリーレン',
          name_cn: '葬送的芙莉莲',
          summary: 'Refreshed summary',
          nsfw: false,
          rating: { score: 8.6, rank: 39 }
        });
      })
    );

    const client = new BangumiClient({
      tokenProvider: new EnvPersonalTokenProvider('test-token'),
      minIntervalMs: 0,
      backoffBaseMs: 5
    });

    // Fire two calls concurrently — client queue must execute them strictly serially
    const [cal, subj] = await Promise.all([client.getCalendar(), client.getSubject(400602)]);

    expect(maxInFlight).toBe(1);
    expect(attempts).toBe(2);
    expect(cal[0]?.items[0]?.id).toBe(400602);
    expect(subj.rating?.score).toBe(8.6);
    expect(seenUserAgents.every((ua) => ua === 'tianchu/mokuroku')).toBe(true);
  });

  it('throws AuthRequiredError when token is missing and TokenExpiredError on 401', async () => {
    const noTokenClient = new BangumiClient({
      tokenProvider: new EnvPersonalTokenProvider(''),
      minIntervalMs: 0
    });
    await expect(noTokenClient.listCollections()).rejects.toBeInstanceOf(AuthRequiredError);

    server.use(
      http.get('https://api.bgm.tv/v0/users/-/collections', () =>
        HttpResponse.json({ title: 'Unauthorized', description: 'token expired' }, { status: 401 })
      )
    );

    const expiredClient = new BangumiClient({
      tokenProvider: new EnvPersonalTokenProvider('expired-token'),
      minIntervalMs: 0
    });
    await expect(expiredClient.listCollections()).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('automatically resolves real username via /v0/me when /v0/users/-/collections returns 404', async () => {
    server.use(
      http.get('https://api.bgm.tv/v0/users/-/collections', () =>
        HttpResponse.json({ title: 'Not Found', description: 'user not found' }, { status: 404 })
      ),
      http.get('https://api.bgm.tv/v0/me', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer pat-token');
        return HttpResponse.json({ id: 888888, username: 'silverash', nickname: 'SilverAsh' });
      }),
      http.get('https://api.bgm.tv/v0/users/silverash/collections', () =>
        HttpResponse.json({
          total: 1,
          limit: 50,
          offset: 0,
          data: [
            {
              subject_id: 400602,
              subject_type: 2,
              type: 3,
              rate: 9,
              ep_status: 5,
              vol_status: 0,
              tags: [],
              private: false,
              updated_at: '2026-11-14T10:00:00Z'
            }
          ]
        })
      )
    );

    const client = new BangumiClient({
      tokenProvider: new EnvPersonalTokenProvider('pat-token'),
      minIntervalMs: 0
    });

    const page = await client.listCollections({ subjectType: 2 });
    expect(page.total).toBe(1);
    expect(page.data[0]?.subject_id).toBe(400602);
  });

  it('caches cover images in cache/covers/{id}.jpg and skips network on cache hit', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mokuroku-covers-'));
    try {
      let imageHits = 0;
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      server.use(
        http.get('https://api.bgm.tv/v0/subjects/400602/image', ({ request }) => {
          expect(new URL(request.url).searchParams.get('type')).toBe('common');
          expect(request.headers.get('user-agent')).toBe('tianchu/mokuroku');
          imageHits += 1;
          return new HttpResponse(new Uint8Array(fakeJpeg), {
            headers: { 'Content-Type': 'image/jpeg' }
          });
        })
      );

      const client = new BangumiClient({
        tokenProvider: new EnvPersonalTokenProvider(''),
        coversDir: tempDir,
        minIntervalMs: 0
      });

      const first = await client.getCoverImage(400602);
      expect(first.fromCache).toBe(false);
      expect(imageHits).toBe(1);

      const second = await client.getCoverImage(400602);
      expect(second.fromCache).toBe(true);
      expect(imageHits).toBe(1); // Zero extra HTTP call
      expect(second.buffer.equals(fakeJpeg)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('pulls collections + watching episodes and computes full dashboard analytics', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mokuroku-dash-'));
    try {
      await importArchiveToSqlite({
        extractDir: FIXTURES_DIR,
        dataDir: tempDir
      });

      server.use(
        http.get('https://api.bgm.tv/v0/users/-/collections', ({ request }) => {
          expect(request.headers.get('authorization')).toBe('Bearer valid-token');
          return HttpResponse.json({
            total: 2,
            limit: 50,
            offset: 0,
            data: [
              {
                subject_id: 400602,
                subject_type: 2,
                type: 3, // 在看
                rate: 9,
                ep_status: 2,
                vol_status: 0,
                tags: ['治愈', '神作'],
                private: false,
                updated_at: '2026-11-14T10:00:00Z',
                subject: { id: 400602, type: 2, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲', eps: 28 }
              },
              {
                subject_id: 265,
                subject_type: 2,
                type: 2, // 看过
                rate: 10,
                ep_status: 26,
                vol_status: 0,
                tags: ['EVA'],
                private: false,
                updated_at: '2026-11-12T10:00:00Z',
                subject: { id: 265, type: 2, name: '新世紀エヴァンゲリオン', name_cn: '新世纪福音战士', eps: 26 }
              }
            ]
          });
        }),
        http.get('https://api.bgm.tv/v0/users/-/collections/400602/episodes', () =>
          HttpResponse.json({
            total: 3,
            limit: 100,
            offset: 0,
            data: [
              {
                episode: { id: 12001, type: 0, sort: 1, name: '冒険の終わり', name_cn: '冒险的结束', airdate: '2023-09-29' },
                type: 2
              },
              {
                episode: { id: 12002, type: 0, sort: 2, name: '別に魔法じゃなくたって…', name_cn: '未必非得是魔法…', airdate: '2023-09-29' },
                type: 2
              },
              {
                episode: { id: 12003, type: 0, sort: 3, name: '人を殺す魔法', name_cn: '杀人魔法', airdate: '2026-11-20' },
                type: 0
              }
            ]
          })
        )
      );

      const colDb = openCollectionDb(join(tempDir, 'collection.db'));
      const archiveDb = openArchiveDb(resolveActiveArchiveDbPath(tempDir), { readonly: true });

      try {
        const client = new BangumiClient({
          tokenProvider: new EnvPersonalTokenProvider('valid-token'),
          minIntervalMs: 0
        });

        const syncRes = await client.pullAllCollectionsToDb(colDb);
        expect(syncRes).toEqual({ totalSaved: 2, episodesSyncedSubjects: 1 });

        const dash = getDashboardData(archiveDb, colDb, {
          season: '2026-10',
          platform: 1,
          now: new Date('2026-11-14T12:00:00Z')
        });

        expect(dash.renderMs).toBeLessThan(500);
        expect(dash.collectionStats.doing).toBe(1);
        expect(dash.collectionStats.done).toBe(1);
        expect(dash.collectionStats.myAvgScore).toBe(9.5);

        // Watching item should compute EP.3 next airdate (2026-11-20, 6 days upcoming)
        expect(dash.watchingList).toHaveLength(1);
        expect(dash.watchingList[0]?.watchedEps).toBe(2);
        expect(dash.watchingList[0]?.nextEpisode?.sort).toBe(3);
        expect(dash.watchingList[0]?.nextEpisode?.airdate).toBe('2026-11-20');
        expect(dash.watchingList[0]?.nextEpisode?.daysDiff).toBe(6);

        // Seasonal anime for 2026-10 platform=1 should include #990002, and 2023-10 should include 2023-09-29 Frieren (#400602)
        expect(dash.seasonalAnime.map((x) => x.id)).toContain(990002);
        const dash2023 = getDashboardData(archiveDb, colDb, { season: '2023-10', platform: 1 });
        expect(dash2023.seasonalAnime.map((x) => x.id)).toContain(400602);

        // Taste profile should include 治愈 & 奇幻
        const tasteNames = dash.tasteTags.map((t) => t.name);
        expect(tasteNames).toContain('治愈');
        expect(tasteNames).toContain('奇幻');

        // Recommendations must NOT contain collected subjects (400602, 265) and MUST rank #990004 (score=8.9, matches 治愈/奇幻)
        const recIds = dash.recommendations.map((r) => r.id);
        expect(recIds).not.toContain(400602);
        expect(recIds).not.toContain(265);
        expect(dash.recommendations[0]?.id).toBe(990004);
        expect(dash.recommendations[0]?.matchedTags).toContain('治愈');

        // Drawer detail should include structured infobox, episodes, and sequel relation
        const drawer = getSubjectDrawerDetail(archiveDb, colDb, 400602);
        expect(drawer?.infobox.find((i) => i.key === '动画制作')?.values).toContain('MADHOUSE');
        expect(drawer?.relations[0]?.relationLabel).toBe('续集');
      } finally {
        archiveDb.close();
        colDb.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
