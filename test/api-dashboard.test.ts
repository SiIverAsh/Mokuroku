import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthRequiredError,
  BangumiClient,
  EnvPersonalTokenProvider,
  TokenExpiredError
} from '../src/api/client.js';
import { openCollectionDb } from '../src/db/open.js';
import {
  getDashboardData,
  getSubjectDrawerDetail
} from '../src/web/lib/server/dashboard.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Bangumi v0 online API client & dashboard (offline MSW)', () => {
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
      expect(imageHits).toBe(1);
      expect(second.buffer.equals(fakeJpeg)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds online dashboard, personalized profile recommendations, and online subject drawer', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mokuroku-online-dash-'));
    const colDb = openCollectionDb(join(tempDir, 'collection.db'));

    try {
      server.use(
        http.get('https://api.bgm.tv/v0/users/-/collections', () =>
          HttpResponse.json({
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
                tags: ['公路片'],
                private: false,
                updated_at: '2026-11-14T10:00:00Z',
                subject: {
                  id: 400602,
                  type: 2,
                  name: '葬送のフリーレン',
                  name_cn: '葬送的芙莉莲',
                  eps: 28,
                  score: 8.5,
                  rank: 43,
                  collection_total: 77828,
                  tags: [
                    { name: '治愈', count: 8162 },
                    { name: '奇幻', count: 6486 }
                  ]
                }
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
                subject: {
                  id: 265,
                  type: 2,
                  name: '新世紀エヴァンゲリオン',
                  name_cn: '新世纪福音战士',
                  eps: 26,
                  score: 8.7,
                  rank: 24,
                  collection_total: 66339,
                  tags: [
                    { name: '科幻', count: 8200 },
                    { name: '治愈', count: 120 }
                  ]
                }
              }
            ]
          })
        ),
        http.get('https://api.bgm.tv/v0/users/-/collections/400602/episodes', () =>
          HttpResponse.json({
            total: 3,
            limit: 100,
            offset: 0,
            data: [
              {
                episode: {
                  id: 12001,
                  type: 0,
                  sort: 1,
                  name: '冒険の終わり',
                  name_cn: '冒险的结束',
                  airdate: '2023-09-29'
                },
                type: 2
              },
              {
                episode: {
                  id: 12002,
                  type: 0,
                  sort: 2,
                  name: '別に魔法じゃなくたって…',
                  name_cn: '未必非得是魔法…',
                  airdate: '2023-09-29'
                },
                type: 2
              },
              {
                episode: {
                  id: 12003,
                  type: 0,
                  sort: 3,
                  name: '人を殺す魔法',
                  name_cn: '杀人魔法',
                  airdate: '2026-11-20'
                },
                type: 0
              }
            ]
          })
        ),
        // Online GET /v0/subjects (handles seasonal cour months and global top rank)
        http.get('https://api.bgm.tv/v0/subjects', ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('year') === '2026') {
            expect(url.searchParams.get('cat')).toBe('1');
            expect(url.searchParams.get('sort')).toBe('date');
            const month = url.searchParams.get('month');
            if (month !== '10') {
              return HttpResponse.json({ total: 0, limit: 50, offset: 0, data: [] });
            }
            return HttpResponse.json({
              total: 1,
              limit: 50,
              offset: 0,
              data: [
                {
                  id: 554779,
                  type: 2,
                  name: '生徒会にも穴はある！',
                  name_cn: '学生会也有洞！',
                  summary: '2026年10月新番',
                  nsfw: false,
                  platform: 'TV',
                  date: '2026-10-03',
                  infobox: [{ key: '动画制作', value: 'Passione' }],
                  rating: { score: 7.7, rank: 548, count: { '8': 400, '7': 200 } },
                  collection: { wish: 3700, collect: 500, doing: 17066, on_hold: 150, dropped: 140 },
                  tags: [{ name: '校园', count: 1356 }, { name: '喜剧', count: 1264 }]
                }
              ]
            });
          }

          return HttpResponse.json({
            total: 2,
            limit: 50,
            offset: 0,
            data: [
              {
                id: 400602, // already collected -> must be excluded from recommendations
                type: 2,
                name: '葬送のフリーレン',
                name_cn: '葬送的芙莉莲',
                summary: '',
                nsfw: false,
                platform: 'TV',
                rating: { score: 8.5, rank: 43, count: { '9': 1300, '8': 1000 } },
                collection: { collect: 55818 },
                tags: [{ name: '治愈', count: 8162 }]
              },
              {
                id: 842,
                type: 2,
                name: '蟲師',
                name_cn: '虫师',
                summary: '奇幻治愈名作',
                nsfw: false,
                platform: 'TV',
                date: '2005-10-22',
                rating: { score: 8.7, rank: 21, count: { '10': 900, '9': 1500, '8': 800 } },
                collection: { wish: 12000, collect: 32000, doing: 2500 },
                tags: [
                  { name: '治愈', count: 6200 },
                  { name: '奇幻', count: 5100 }
                ],
                meta_tags: ['TV', '奇幻']
              }
            ]
          });
        }),
        // Tag-targeted online search for profile recommendations
        http.post('https://api.bgm.tv/v0/search/subjects', () =>
          HttpResponse.json({
            total: 1,
            limit: 30,
            offset: 0,
            data: [
              {
                id: 253,
                type: 2,
                name: 'ARIA The ORIGINATION',
                name_cn: '水星领航员 第三季',
                summary: '治愈神作',
                nsfw: false,
                platform: 'TV',
                date: '2008-01-07',
                rating: { score: 8.9, rank: 10 },
                collection: { wish: 5000, collect: 15000, doing: 800 },
                tags: [{ name: '治愈', count: 4800 }, { name: '科幻', count: 2100 }]
              }
            ]
          })
        ),
        // Online drawer endpoints
        http.get('https://api.bgm.tv/v0/subjects/400602', () =>
          HttpResponse.json({
            id: 400602,
            type: 2,
            name: '葬送のフリーレン',
            name_cn: '葬送的芙莉莲',
            summary: '勇者一行后日谈',
            nsfw: false,
            platform: 'TV',
            date: '2023-09-29',
            infobox: [
              { key: '动画制作', value: 'MADHOUSE' },
              { key: '别名', value: [{ v: 'Sousou no Frieren' }] }
            ],
            rating: { score: 8.5, rank: 43, count: { '9': 13000, '8': 10000 } },
            collection: { wish: 7209, collect: 55818, doing: 11935, on_hold: 2087, dropped: 779 },
            tags: [{ name: '治愈', count: 8162 }]
          })
        ),
        http.get('https://api.bgm.tv/v0/episodes', () =>
          HttpResponse.json({
            total: 2,
            limit: 100,
            offset: 0,
            data: [
              { id: 12001, type: 0, sort: 1, name: '冒険の終わり', name_cn: '冒险的结束', airdate: '2023-09-29' },
              { id: 12002, type: 0, sort: 2, name: '別に魔法じゃなくたって…', name_cn: '未必非得是魔法…', airdate: '2023-09-29' }
            ]
          })
        ),
        http.get('https://api.bgm.tv/v0/subjects/400602/characters', () =>
          HttpResponse.json([
            {
              id: 11001,
              name: 'フリーレン',
              type: 1,
              relation: '主角',
              actors: [{ id: 17265, name: '種﨑敦美' }]
            }
          ])
        ),
        http.get('https://api.bgm.tv/v0/subjects/400602/subjects', () =>
          HttpResponse.json([
            {
              id: 515759,
              type: 2,
              name: '葬送のフリーレン 第2期',
              name_cn: '葬送的芙莉莲 第二季',
              relation: '续集'
            }
          ])
        )
      );

      const client = new BangumiClient({
        tokenProvider: new EnvPersonalTokenProvider('valid-token'),
        cacheDb: colDb,
        minIntervalMs: 0
      });

      const syncRes = await client.pullAllCollectionsToDb(colDb);
      expect(syncRes).toEqual({ totalSaved: 2, episodesSyncedSubjects: 1 });

      const dash = await getDashboardData(colDb, client, {
        season: '2026-10',
        platform: 1,
        now: new Date('2026-11-14T12:00:00Z')
      });

      expect(dash.mode).toBe('online');
      expect(dash.onlineError).toBeNull();
      expect(dash.collectionStats.doing).toBe(1);
      expect(dash.collectionStats.done).toBe(1);
      expect(dash.collectionStats.myAvgScore).toBe(9.5);
      expect(dash.collectionStats.siteAvgScore).toBe(8.6);

      // Watching progress & next episode airdate
      expect(dash.watchingList[0]?.watchedEps).toBe(2);
      expect(dash.watchingList[0]?.nextEpisode?.sort).toBe(3);
      expect(dash.watchingList[0]?.nextEpisode?.daysDiff).toBe(6);

      // Seasonal anime from online GET /v0/subjects
      expect(dash.seasonalAnime[0]?.id).toBe(554779);
      expect(dash.seasonalAnime[0]?.studio).toBe('Passione');

      // Personal taste profile aggregated directly from SlimSubject tags
      expect(dash.tasteTags.map((t) => t.name)).toContain('治愈');

      // Profile-driven recommendations exclude collected #400602/#265 and include tag-matched #253 & #842
      const recIds = dash.recommendations.map((r) => r.id);
      expect(recIds).not.toContain(400602);
      expect(recIds).not.toContain(265);
      expect(recIds).toContain(253);
      expect(recIds).toContain(842);
      expect(dash.recommendations[0]?.matchedTags).toContain('治愈');

      // Online SubjectDrawer detail
      const drawer = await getSubjectDrawerDetail(colDb, client, 400602);
      expect(drawer?.infobox.find((x) => x.key === '动画制作')?.values).toContain('MADHOUSE');
      expect(drawer?.characters[0]?.cvNames).toContain('種﨑敦美');
      expect(drawer?.relations[0]?.relationLabel).toBe('续集');
    } finally {
      colDb.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('gracefully degrades with onlineError banner instead of crashing when api.bgm.tv is unreachable', async () => {
    const colDb = openCollectionDb(':memory:');
    try {
      colDb
        .prepare(
          `INSERT INTO collection (
             subject_id, subject_type, type, rate, ep_status, updated_at,
             subject_name, subject_name_cn, subject_score, subject_tags_json
           ) VALUES (
             400602, 2, 3, 9, 4, '2026-11-14T10:00:00Z',
             '葬送のフリーレン', '葬送的芙莉莲', 8.5, '[{"name":"治愈","count":8162}]'
           )`
        )
        .run();

      server.use(
        http.get('https://api.bgm.tv/v0/subjects', () =>
          new HttpResponse('Gateway Timeout', { status: 504 })
        )
      );

      const client = new BangumiClient({
        tokenProvider: new EnvPersonalTokenProvider(''),
        cacheDb: colDb,
        minIntervalMs: 0,
        maxRetries: 0
      });

      const dash = await getDashboardData(colDb, client, { season: '2026-10' });
      expect(dash.onlineError).toBeTruthy();
      expect(dash.collectionStats.doing).toBe(1);
      expect(dash.tasteTags[0]?.name).toBe('治愈');
    } finally {
      colDb.close();
    }
  });

  it('paginates all seasonal anime beyond 50 items across the full cour window and includes unranked entries', async () => {
    const colDb = openCollectionDb(':memory:');
    try {
      const octSubjects = Array.from({ length: 65 }, (_, idx) => ({
        id: 600001 + idx,
        type: 2,
        name: `Autumn Anime #${idx + 1}`,
        name_cn: `十月番 #${idx + 1}`,
        summary: '',
        nsfw: false,
        platform: 'TV',
        date: `2026-10-${String((idx % 28) + 1).padStart(2, '0')}`,
        // Half unranked to verify sort='date' keeps newly airing / upcoming entries
        rating: idx < 30 ? { score: 7.5, rank: 800 + idx } : { score: 0 },
        collection: { wish: 500 - idx, doing: 1000 - idx * 10 }
      }));

      let sepPageCalls = 0;

      server.use(
        http.get('https://api.bgm.tv/v0/subjects', ({ request }) => {
          const url = new URL(request.url);
          const year = url.searchParams.get('year');
          const month = url.searchParams.get('month');
          const offset = Number(url.searchParams.get('offset') ?? '0');
          const limit = Number(url.searchParams.get('limit') ?? '50');

          if (!year) {
            // Global top benchmark query
            return HttpResponse.json({ total: 0, limit, offset, data: [] });
          }

          expect(url.searchParams.get('sort')).toBe('date');

          if (year === '2026' && month === '9') {
            sepPageCalls += 1;
            // Page 0 contains both a late-Sep cour premiere (>= 09-25) and an older mid-Sep item (< 09-25)
            return HttpResponse.json({
              total: 120,
              limit,
              offset,
              data: [
                {
                  id: 599901,
                  type: 2,
                  name: 'Early Cour Premiere',
                  name_cn: '九月末抢跑新番',
                  summary: '',
                  nsfw: false,
                  platform: 'TV',
                  date: '2026-09-28',
                  collection: { doing: 5000 }
                },
                {
                  id: 599800,
                  type: 2,
                  name: 'Summer Leftover',
                  name_cn: '七月番尾声',
                  summary: '',
                  nsfw: false,
                  platform: 'TV',
                  date: '2026-09-18',
                  collection: { doing: 300 }
                }
              ]
            });
          }

          if (year === '2026' && month === '10') {
            if (offset >= octSubjects.length) {
              return new HttpResponse('offset out of range', { status: 400 });
            }
            return HttpResponse.json({
              total: octSubjects.length,
              limit,
              offset,
              data: octSubjects.slice(offset, offset + limit)
            });
          }

          if (year === '2026' && month === '11') {
            return HttpResponse.json({
              total: 2,
              limit,
              offset,
              data: [
                {
                  id: 610001,
                  type: 2,
                  name: 'Nov Web Anime',
                  name_cn: '十一月网飞独播',
                  summary: '',
                  nsfw: false,
                  platform: 'WEB',
                  date: '2026-11-12',
                  collection: { wish: 800, doing: 200 }
                },
                {
                  id: 610002,
                  type: 2,
                  name: 'Nov Undated OVA',
                  name_cn: '十一月未定日OVA',
                  summary: '',
                  nsfw: false,
                  platform: 'OVA',
                  date: '',
                  collection: { wish: 120 }
                }
              ]
            });
          }

          if (year === '2026' && month === '12') {
            return HttpResponse.json({
              total: 2,
              limit,
              offset,
              data: [
                {
                  id: 620001,
                  type: 2,
                  name: 'Dec Winter Early Premiere',
                  name_cn: '十二月末一月番抢跑',
                  summary: '',
                  nsfw: false,
                  platform: 'TV',
                  date: '2026-12-27',
                  collection: { doing: 3000 }
                },
                {
                  id: 620002,
                  type: 2,
                  name: 'Dec Autumn Movie',
                  name_cn: '十二月秋季剧场版',
                  summary: '',
                  nsfw: false,
                  platform: '剧场版',
                  date: '2026-12-18',
                  collection: { wish: 1500, doing: 400 }
                }
              ]
            });
          }

          return HttpResponse.json({ total: 0, limit, offset, data: [] });
        })
      );

      const client = new BangumiClient({
        tokenProvider: new EnvPersonalTokenProvider(''),
        cacheDb: colDb,
        minIntervalMs: 0
      });

      const dash = await getDashboardData(colDb, client, {
        season: '2026-10',
        now: new Date('2026-11-14T12:00:00Z')
      });

      expect(dash.onlineError).toBeNull();
      // 1 (Sep >= 09-25) + 65 (Oct across 2 pages) + 2 (Nov) + 1 (Dec <= 12-24) = 69 items (> 50!)
      expect(dash.seasonalAnime.length).toBe(69);
      expect(sepPageCalls).toBe(1); // stopped after page 0 upon seeing 2026-09-18 < 2026-09-25

      const ids = new Set(dash.seasonalAnime.map((x) => x.id));
      expect(ids.has(599901)).toBe(true); // 2026-09-28 included
      expect(ids.has(599800)).toBe(false); // 2026-09-18 excluded
      expect(ids.has(600065)).toBe(true); // 65th Oct unranked anime from page 2 included
      expect(ids.has(610002)).toBe(true); // Nov undated OVA included with fallback '2026-11'
      expect(ids.has(620002)).toBe(true); // 2026-12-18 included
      expect(ids.has(620001)).toBe(false); // 2026-12-27 belongs to 2027-01 cour window
      expect(dash.seasonalAnime.find((x) => x.id === 610002)?.date).toBe('2026-11');
      expect(dash.seasonalAnime[0]?.id).toBe(599901); // highest favDoing (5000) sorted first
    } finally {
      colDb.close();
    }
  });
});
