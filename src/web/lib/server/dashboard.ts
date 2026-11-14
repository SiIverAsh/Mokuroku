import type Database from 'better-sqlite3';
import type { BangumiClient, BangumiEpisodeItem, BangumiSubjectDetail } from '../../../api/client.js';
import { loadDotEnv } from '../../../config.js';
import {
  COLLECTION_TYPE_NAMES,
  getSubjectTypeLabel,
  normalizePlatformLabel
} from '../../../db/constants.js';
import { readApiCache } from '../../../db/open.js';
import {
  type SearchHit,
  extractWikiV0Metadata,
  searchSubjectsOnline
} from '../../../search.js';

export interface CollectionStatusStats {
  wish: number;
  done: number;
  doing: number;
  onHold: number;
  dropped: number;
  total: number;
  ratedCount: number;
  myAvgScore: number | null;
  siteAvgScore: number | null;
}

export interface ScoreBucket {
  score: number; // 1..10
  myCount: number;
  myPct: number;
  siteCount: number;
  sitePct: number;
}

export interface WatchingItem {
  subjectId: number;
  name: string;
  nameCn: string;
  platformLabel: string;
  score: number | null;
  myRate: number;
  watchedEps: number;
  totalEps: number;
  progressPct: number;
  updatedAt: string;
  nextEpisode: {
    id: number;
    sort: number;
    title: string;
    airdate: string | null;
    airStatus: 'today' | 'upcoming' | 'aired' | 'tba';
    daysDiff: number | null;
  } | null;
}

export interface SeasonalAnimeItem {
  id: number;
  name: string;
  nameCn: string;
  platform: number | null;
  platformLabel: string;
  date: string;
  score: number | null;
  rank: number | null;
  favDoing: number;
  favTotal: number;
  studio: string;
  tags: string[];
  myCollectionType: number | null;
  myRate: number;
}

export interface TasteTagItem {
  name: string;
  count: number;
  weight: number;
  avgRate: number | null;
}

export interface RecommendationItem {
  id: number;
  name: string;
  nameCn: string;
  platformLabel: string;
  date: string | null;
  score: number;
  rank: number;
  favTotal: number;
  matchedTags: string[];
  topTags: string[];
  recScore: number;
}

export interface DashboardData {
  mode: 'online';
  renderMs: number;
  onlineError: string | null;
  syncSummary: {
    cachedEntries: number;
    lastCollectionSync: string | null;
    lastCalendarSync: string | null;
    tokenConfigured: boolean;
  };
  collectionStats: CollectionStatusStats;
  scoreDistribution: ScoreBucket[];
  scoreDistributionBasis: 'my_collection' | 'site_top_benchmark';
  watchingList: WatchingItem[];
  seasonFilter: {
    current: string;
    platform: number | null;
    options: string[];
  };
  seasonalAnime: SeasonalAnimeItem[];
  tasteTags: TasteTagItem[];
  recommendations: RecommendationItem[];
  searchQuery: string;
  searchType: number | null;
  searchResults: SearchHit[];
}

const NOISE_TAGS = new Set([
  'TV',
  'OVA',
  'OAD',
  'WEB',
  'Web',
  '剧场版',
  '日本',
  '动画',
  '日本动画',
  'Anime',
  'アニメ',
  'TVA',
  '补番',
  '已完结',
  '待看'
]);

function isNoiseTag(tag: string): boolean {
  const t = tag.trim();
  if (!t || t.length > 24) return true;
  if (NOISE_TAGS.has(t)) return true;
  if (/^\d{4}(年(\d{1,2}月)?)?$/.test(t)) return true;
  if (/^\d{1,2}月$/.test(t)) return true;
  return false;
}

export function getCurrentSeasonCode(now = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const qMonth = month >= 10 ? '10' : month >= 7 ? '07' : month >= 4 ? '04' : '01';
  return `${year}-${qMonth}`;
}

export function buildRecentSeasonOptions(now = new Date(), count = 16): string[] {
  let year = now.getFullYear();
  const m = now.getMonth() + 1;
  let qIdx = m >= 10 ? 3 : m >= 7 ? 2 : m >= 4 ? 1 : 0;
  const quarters = ['01', '04', '07', '10'];
  const list: string[] = [];
  for (let i = 0; i < count; i++) {
    list.push(`${year}-${quarters[qIdx]}`);
    qIdx -= 1;
    if (qIdx < 0) {
      qIdx = 3;
      year -= 1;
    }
  }
  return list;
}

function parseSeasonYearMonth(seasonCode: string): { year: number; month: number } {
  const m = /^(\d{4})-(01|04|07|10)$/.exec(seasonCode.trim());
  if (!m) {
    return parseSeasonYearMonth(getCurrentSeasonCode());
  }
  return {
    year: Number(m[1]),
    month: Number(m[2])
  };
}

function computeAirStatus(
  airdate: string | null | undefined,
  todayIso: string
): { status: 'today' | 'upcoming' | 'aired' | 'tba'; daysDiff: number | null } {
  if (!airdate || !/^\d{4}-\d{2}-\d{2}$/.test(airdate.trim())) {
    return { status: 'tba', daysDiff: null };
  }
  const clean = airdate.trim();
  if (clean === todayIso) {
    return { status: 'today', daysDiff: 0 };
  }
  const targetMs = Date.parse(`${clean}T00:00:00Z`);
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(targetMs) || Number.isNaN(todayMs)) {
    return { status: 'tba', daysDiff: null };
  }
  const daysDiff = Math.round((targetMs - todayMs) / 86_400_000);
  return {
    status: daysDiff > 0 ? 'upcoming' : 'aired',
    daysDiff
  };
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface CollectionRow {
  subject_id: number;
  subject_type: number;
  type: number;
  rate: number;
  ep_status: number;
  vol_status: number;
  comment: string;
  tags: string;
  private: number;
  updated_at: string;
  subject_name: string;
  subject_name_cn: string;
  subject_eps: number;
  subject_date: string | null;
  subject_score: number | null;
  subject_rank: number | null;
  subject_total: number;
  subject_platform: string;
  subject_tags_json: string;
}

export async function getDashboardData(
  collectionDb: Database.Database,
  client: BangumiClient,
  params?: {
    season?: string;
    platform?: number | null;
    q?: string;
    searchType?: number | null;
    now?: Date;
  }
): Promise<DashboardData> {
  const t0 = performance.now();
  loadDotEnv();
  const now = params?.now ?? new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const seasonOptions = buildRecentSeasonOptions(now, 16);
  const currentSeason =
    params?.season && /^\d{4}-(01|04|07|10)$/.test(params.season)
      ? params.season
      : getCurrentSeasonCode(now);
  const platformFilter =
    params?.platform !== undefined && params.platform !== null && !Number.isNaN(params.platform)
      ? Number(params.platform)
      : null;

  const syncRows = collectionDb.prepare('SELECT key, value FROM sync_state').all() as Array<{
    key: string;
    value: string;
  }>;
  const syncMap = new Map(syncRows.map((r) => [r.key, r.value]));
  const tokenConfigured = Boolean((process.env.BGM_ACCESS_TOKEN ?? '').trim());

  const collections = collectionDb
    .prepare('SELECT * FROM collection WHERE subject_type = 2 ORDER BY updated_at DESC')
    .all() as CollectionRow[];
  const collectionBySubjectId = new Map<number, CollectionRow>(
    collections.map((c) => [c.subject_id, c])
  );

  let onlineError: string | null = null;
  const recordOnlineError = (err: unknown) => {
    if (!onlineError) {
      const msg = err instanceof Error ? err.message : String(err);
      onlineError = `连接 Bangumi 在线服务异常（已回退本地缓存）: ${msg}`;
    }
  };

  // 1. Collection status counts & my rating buckets
  const stats: CollectionStatusStats = {
    wish: 0,
    done: 0,
    doing: 0,
    onHold: 0,
    dropped: 0,
    total: collections.length,
    ratedCount: 0,
    myAvgScore: null,
    siteAvgScore: null
  };

  const myBuckets = new Array<number>(11).fill(0);
  let myRateSum = 0;
  let collectedSiteScoreSum = 0;
  let collectedSiteScoreCnt = 0;

  for (const c of collections) {
    if (c.type === 1) stats.wish += 1;
    else if (c.type === 2) stats.done += 1;
    else if (c.type === 3) stats.doing += 1;
    else if (c.type === 4) stats.onHold += 1;
    else if (c.type === 5) stats.dropped += 1;

    if (c.rate >= 1 && c.rate <= 10) {
      stats.ratedCount += 1;
      myRateSum += c.rate;
      myBuckets[c.rate] += 1;
    }

    if (typeof c.subject_score === 'number' && c.subject_score > 0) {
      collectedSiteScoreSum += c.subject_score;
      collectedSiteScoreCnt += 1;
    }
  }

  if (stats.ratedCount > 0) {
    stats.myAvgScore = Number((myRateSum / stats.ratedCount).toFixed(2));
  }
  if (collectedSiteScoreCnt > 0) {
    stats.siteAvgScore = Number((collectedSiteScoreSum / collectedSiteScoreCnt).toFixed(2));
  }

  // 2. Personal Taste Profile (from collected SlimSubject tags + user tags + any cached subject details)
  const tagAgg = new Map<
    string,
    { count: number; weight: number; rateSum: number; rateCnt: number }
  >();

  for (const c of collections) {
    if (c.type !== 1 && c.type !== 2 && c.type !== 3) continue;

    const statusBase = c.type === 2 ? 1.0 : c.type === 3 ? 0.9 : 0.55;
    const rateFactor =
      c.rate >= 8 ? 1.0 + (c.rate - 7) * 0.35 : c.rate >= 1 && c.rate <= 5 ? 0.35 : 1.0;
    const itemWeight = statusBase * rateFactor;

    const perItemTags = new Set<string>();
    const userTags = safeParseJson<string[]>(c.tags, []);
    for (const ut of userTags) {
      if (typeof ut === 'string' && !isNoiseTag(ut)) perItemTags.add(ut.trim());
    }

    const slimTags = safeParseJson<Array<{ name: string; count?: number }>>(
      c.subject_tags_json,
      []
    ).slice(0, 12);
    for (const st of slimTags) {
      if (st?.name && !isNoiseTag(st.name)) perItemTags.add(st.name.trim());
    }

    if (perItemTags.size === 0) {
      const cachedDetail = readApiCache<BangumiSubjectDetail>(
        collectionDb,
        `subject:${c.subject_id}`,
        true
      );
      if (cachedDetail?.value?.tags) {
        for (const t of cachedDetail.value.tags.slice(0, 12)) {
          if (t?.name && !isNoiseTag(t.name)) perItemTags.add(t.name.trim());
        }
      }
    }

    for (const tag of perItemTags) {
      const prev = tagAgg.get(tag) ?? { count: 0, weight: 0, rateSum: 0, rateCnt: 0 };
      prev.count += 1;
      prev.weight += itemWeight;
      if (c.rate >= 1 && c.rate <= 10) {
        prev.rateSum += c.rate;
        prev.rateCnt += 1;
      }
      tagAgg.set(tag, prev);
    }
  }

  const tasteTags: TasteTagItem[] = Array.from(tagAgg.entries())
    .map(([name, v]) => ({
      name,
      count: v.count,
      weight: Number(v.weight.toFixed(2)),
      avgRate: v.rateCnt > 0 ? Number((v.rateSum / v.rateCnt).toFixed(1)) : null
    }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count)
    .slice(0, 36);

  const maxTasteWeight = tasteTags[0]?.weight ?? 1;
  const topTasteMap = new Map<string, number>();
  for (const t of tasteTags.slice(0, 25)) {
    topTasteMap.set(t.name, t.weight / Math.max(1, maxTasteWeight));
  }

  // 3. Online Seasonal Anime (GET /v0/subjects?type=2&year=YYYY&month=MM&cat=...)
  const { year: seasonYear, month: seasonMonth } = parseSeasonYearMonth(currentSeason);
  let seasonalSubjects: BangumiSubjectDetail[] = [];
  try {
    const page = await client.browseSubjects({
      type: 2,
      year: seasonYear,
      month: seasonMonth,
      cat: platformFilter !== null ? platformFilter : undefined,
      sort: 'rank',
      limit: 50,
      offset: 0
    });
    seasonalSubjects = page.data ?? [];
  } catch (err) {
    recordOnlineError(err);
  }

  const seasonalAnime: SeasonalAnimeItem[] = seasonalSubjects
    .filter((s) => !s.nsfw)
    .map((s) => {
      const col = collectionBySubjectId.get(s.id);
      const { studio } = extractWikiV0Metadata(s.infobox);
      const cleanTags = (s.tags ?? [])
        .map((t) => t.name)
        .filter((n) => Boolean(n) && !isNoiseTag(n))
        .slice(0, 4);
      const wish = Number(s.collection?.wish ?? 0) || 0;
      const done = Number(s.collection?.collect ?? 0) || 0;
      const doing = Number(s.collection?.doing ?? 0) || 0;
      const onHold = Number(s.collection?.on_hold ?? 0) || 0;
      const dropped = Number(s.collection?.dropped ?? 0) || 0;

      return {
        id: s.id,
        name: s.name,
        nameCn: s.name_cn ?? '',
        platform: null,
        platformLabel: normalizePlatformLabel(s.platform, s.type) || 'TV',
        date: s.date ?? `${seasonYear}-${String(seasonMonth).padStart(2, '0')}`,
        score: typeof s.rating?.score === 'number' && s.rating.score > 0 ? s.rating.score : null,
        rank: typeof s.rating?.rank === 'number' && s.rating.rank > 0 ? s.rating.rank : null,
        favDoing: doing,
        favTotal: wish + done + doing + onHold + dropped,
        studio,
        tags: cleanTags,
        myCollectionType: col?.type ?? null,
        myRate: col?.rate ?? 0
      };
    })
    .sort((a, b) => b.favDoing - a.favDoing || (b.score ?? 0) - (a.score ?? 0));

  // 4. Online High-Score & Profile-Matched Recommendations
  const recCandidateMap = new Map<number, BangumiSubjectDetail>();
  let topBenchmarkSubjects: BangumiSubjectDetail[] = [];

  if (!onlineError) {
    try {
      const topPage = await client.browseSubjects({
        type: 2,
        sort: 'rank',
        limit: 50,
        offset: 0
      });
      topBenchmarkSubjects = topPage.data ?? [];
      for (const s of topBenchmarkSubjects) {
        recCandidateMap.set(s.id, s);
      }

      // When user has personal taste profile, also pull online high-score candidates matching top 2 preference tags
      for (const taste of tasteTags.slice(0, 2)) {
        const tagPage = await client.searchSubjects({
          keyword: '',
          sort: 'rank',
          types: [2],
          tags: [taste.name],
          rating: ['>=7.5'],
          includeNsfw: false,
          limit: 30
        });
        for (const s of tagPage.data ?? []) {
          if (!recCandidateMap.has(s.id)) {
            recCandidateMap.set(s.id, s);
          }
        }
      }
    } catch (err) {
      recordOnlineError(err);
    }
  } else {
    const staleTop = readApiCache<{ data?: BangumiSubjectDetail[] }>(
      collectionDb,
      'browse:type=2&sort=rank&limit=50&offset=0',
      true
    );
    topBenchmarkSubjects = staleTop?.value?.data ?? [];
    for (const s of topBenchmarkSubjects) {
      recCandidateMap.set(s.id, s);
    }
  }

  const recommendations: RecommendationItem[] = [];
  for (const cand of recCandidateMap.values()) {
    if (cand.nsfw || collectionBySubjectId.has(cand.id)) continue;
    const score = cand.rating?.score ?? 0;
    const rank = cand.rating?.rank ?? 0;
    if (score < 7.2 || rank <= 0) continue;

    const wish = Number(cand.collection?.wish ?? 0) || 0;
    const done = Number(cand.collection?.collect ?? 0) || 0;
    const doing = Number(cand.collection?.doing ?? 0) || 0;
    const onHold = Number(cand.collection?.on_hold ?? 0) || 0;
    const dropped = Number(cand.collection?.dropped ?? 0) || 0;
    const favTotal = wish + done + doing + onHold + dropped;

    const candTagSet = new Set<string>();
    const displayTags: string[] = [];
    for (const t of (cand.tags ?? []).slice(0, 14)) {
      if (t?.name && !isNoiseTag(t.name)) {
        candTagSet.add(t.name.trim());
        if (displayTags.length < 4) displayTags.push(t.name.trim());
      }
    }
    for (const mt of cand.meta_tags ?? []) {
      if (typeof mt === 'string' && !isNoiseTag(mt)) {
        candTagSet.add(mt.trim());
      }
    }

    const matchedTags: string[] = [];
    let affinityBonus = 0;
    for (const tag of candTagSet) {
      const w = topTasteMap.get(tag);
      if (w !== undefined) {
        matchedTags.push(tag);
        affinityBonus += w * 14.0;
      }
    }

    const qualityScore =
      score * 8.5 + (1500 - Math.min(1400, rank)) * 0.02 + Math.log1p(favTotal) * 0.8;
    const recScore = Number((qualityScore + affinityBonus).toFixed(2));

    recommendations.push({
      id: cand.id,
      name: cand.name,
      nameCn: cand.name_cn ?? '',
      platformLabel: normalizePlatformLabel(cand.platform, cand.type) || 'TV',
      date: cand.date ?? null,
      score,
      rank,
      favTotal,
      matchedTags: matchedTags.slice(0, 4),
      topTags: displayTags,
      recScore
    });
  }

  recommendations.sort((a, b) => b.recScore - a.recScore || a.rank - b.rank);
  const topRecommendations = recommendations.slice(0, 24);

  // 5. Site Score Distribution (use cached collected subjects if available, else online top-50 benchmark)
  const siteBuckets = new Array<number>(11).fill(0);
  let siteVoteTotal = 0;
  let scoreDistributionBasis: 'my_collection' | 'site_top_benchmark' = 'site_top_benchmark';

  let cachedCollectedCount = 0;
  for (const c of collections) {
    const cached = readApiCache<BangumiSubjectDetail>(collectionDb, `subject:${c.subject_id}`, true);
    const counts = cached?.value?.rating?.count;
    if (counts) {
      cachedCollectedCount += 1;
      for (let k = 1; k <= 10; k++) {
        const v = Number(counts[String(k)] ?? 0) || 0;
        siteBuckets[k] += v;
        siteVoteTotal += v;
      }
    }
  }

  if (cachedCollectedCount > 0 && siteVoteTotal > 0) {
    scoreDistributionBasis = 'my_collection';
  } else {
    let benchScoreSum = 0;
    let benchScoreCnt = 0;
    for (const b of topBenchmarkSubjects) {
      if (typeof b.rating?.score === 'number' && b.rating.score > 0) {
        benchScoreSum += b.rating.score;
        benchScoreCnt += 1;
      }
      const counts = b.rating?.count;
      if (counts) {
        for (let k = 1; k <= 10; k++) {
          const v = Number(counts[String(k)] ?? 0) || 0;
          siteBuckets[k] += v;
          siteVoteTotal += v;
        }
      }
    }
    if (stats.siteAvgScore === null && benchScoreCnt > 0) {
      stats.siteAvgScore = Number((benchScoreSum / benchScoreCnt).toFixed(2));
    }
  }

  const scoreDistribution: ScoreBucket[] = [];
  for (let s = 10; s >= 1; s--) {
    scoreDistribution.push({
      score: s,
      myCount: myBuckets[s],
      myPct:
        stats.ratedCount > 0 ? Number(((myBuckets[s] / stats.ratedCount) * 100).toFixed(1)) : 0,
      siteCount: siteBuckets[s],
      sitePct:
        siteVoteTotal > 0 ? Number(((siteBuckets[s] / siteVoteTotal) * 100).toFixed(1)) : 0
    });
  }

  // 6. Watching list + episode progress + next episode airdate (online / episode_progress)
  const watchingCols = collections.filter((c) => c.type === 3);
  const getEpProgressStmt = collectionDb.prepare(`
    SELECT episode_id, type, sort, ep_type, name, name_cn, airdate
    FROM episode_progress
    WHERE subject_id = ?
    ORDER BY sort ASC, episode_id ASC
  `);

  const watchingList: WatchingItem[] = [];
  for (const c of watchingCols) {
    const localEpRows = getEpProgressStmt.all(c.subject_id) as Array<{
      episode_id: number;
      type: number;
      sort: number | null;
      ep_type: number;
      name: string;
      name_cn: string;
      airdate: string | null;
    }>;

    let episodes: Array<{
      id: number;
      sort: number;
      name: string;
      name_cn: string;
      airdate: string | null;
      watched: boolean;
    }> = [];

    if (localEpRows.length > 0) {
      episodes = localEpRows
        .filter((e) => e.ep_type === 0)
        .map((e) => ({
          id: e.episode_id,
          sort: e.sort ?? 0,
          name: e.name,
          name_cn: e.name_cn,
          airdate: e.airdate,
          watched: e.type === 2
        }));
    } else if (!onlineError && watchingCols.length <= 25) {
      try {
        const epPage = await client.getSubjectEpisodes(c.subject_id, { type: 0, limit: 100 });
        episodes = (epPage.data ?? []).map((ep: BangumiEpisodeItem) => ({
          id: ep.id,
          sort: ep.sort ?? 0,
          name: ep.name ?? '',
          name_cn: ep.name_cn ?? '',
          airdate: ep.airdate || null,
          watched: (c.ep_status || 0) > 0 && ep.sort <= (c.ep_status || 0)
        }));
      } catch (err) {
        recordOnlineError(err);
      }
    }

    const watchedCountFromEp = episodes.filter((e) => e.watched).length;
    const watchedEps = Math.max(c.ep_status || 0, watchedCountFromEp);
    const totalEps = episodes.length || c.subject_eps || 0;

    const nextEpRow =
      episodes.find((ep) => !ep.watched && ep.sort > watchedEps) ??
      episodes.find((ep) => !ep.watched && ep.sort > 0);

    let nextEpisode: WatchingItem['nextEpisode'] = null;
    if (nextEpRow) {
      const air = computeAirStatus(nextEpRow.airdate, todayIso);
      nextEpisode = {
        id: nextEpRow.id,
        sort: nextEpRow.sort,
        title: nextEpRow.name_cn || nextEpRow.name || `第${nextEpRow.sort}话`,
        airdate: nextEpRow.airdate,
        airStatus: air.status,
        daysDiff: air.daysDiff
      };
    }

    const progressPct =
      totalEps > 0 ? Math.min(100, Math.round((watchedEps / totalEps) * 100)) : 0;

    watchingList.push({
      subjectId: c.subject_id,
      name: c.subject_name || `#${c.subject_id}`,
      nameCn: c.subject_name_cn || '',
      platformLabel: normalizePlatformLabel(c.subject_platform, 2) || 'TV',
      score: c.subject_score ?? null,
      myRate: c.rate,
      watchedEps,
      totalEps,
      progressPct,
      updatedAt: c.updated_at,
      nextEpisode
    });
  }

  // 7. Optional SSR search query (online)
  const searchQuery = (params?.q ?? '').trim();
  const searchType =
    params?.searchType !== undefined && params.searchType !== null
      ? Number(params.searchType)
      : null;
  let searchResults: SearchHit[] = [];
  if (searchQuery) {
    try {
      searchResults = await searchSubjectsOnline(client, searchQuery, {
        type: searchType ?? undefined,
        limit: 30
      });
    } catch (err) {
      recordOnlineError(err);
    }
  }

  const cacheCountRow = collectionDb
    .prepare('SELECT COUNT(*) AS cnt FROM api_cache')
    .get() as { cnt: number };

  return {
    mode: 'online',
    renderMs: Number((performance.now() - t0).toFixed(2)),
    onlineError,
    syncSummary: {
      cachedEntries: cacheCountRow.cnt ?? 0,
      lastCollectionSync: syncMap.get('last_collection_sync') ?? null,
      lastCalendarSync: syncMap.get('last_calendar_sync') ?? null,
      tokenConfigured
    },
    collectionStats: stats,
    scoreDistribution,
    scoreDistributionBasis,
    watchingList,
    seasonFilter: {
      current: currentSeason,
      platform: platformFilter,
      options: seasonOptions
    },
    seasonalAnime,
    tasteTags,
    recommendations: topRecommendations,
    searchQuery,
    searchType,
    searchResults
  };
}

export interface SubjectDrawerDetail {
  id: number;
  type: number;
  typeLabel: string;
  platform: number | null;
  platformLabel: string;
  name: string;
  nameCn: string;
  aliases: string[];
  date: string | null;
  score: number | null;
  rank: number | null;
  summary: string;
  favorite: {
    wish: number;
    done: number;
    doing: number;
    on_hold: number;
    dropped: number;
  };
  tags: Array<{ name: string; count: number }>;
  metaTags: string[];
  infobox: Array<{ key: string; values: string[] }>;
  episodes: Array<{
    id: number;
    sort: number;
    type: number;
    name: string;
    nameCn: string;
    airdate: string | null;
    duration: string | null;
    watched: boolean;
  }>;
  characters: Array<{
    id: number;
    name: string;
    roleType: number;
    cvNames: string[];
  }>;
  relations: Array<{
    relatedId: number;
    relationLabel: string;
    name: string;
    nameCn: string;
    typeLabel: string;
    score: number | null;
  }>;
  myCollection: {
    type: number; // 0 = not collected, 1..5
    typeLabel: string;
    rate: number;
    epStatus: number;
    comment: string;
    tags: string[];
    updatedAt: string;
  };
  refreshedAt: string | null;
}

export async function getSubjectDrawerDetail(
  collectionDb: Database.Database,
  client: BangumiClient,
  subjectId: number,
  options?: { forceRefresh?: boolean }
): Promise<SubjectDrawerDetail | null> {
  const forceRefresh = options?.forceRefresh ?? false;

  let subject: BangumiSubjectDetail;
  try {
    subject = await client.getSubject(subjectId, { forceRefresh });
  } catch {
    return null;
  }

  const [epPage, charList, relList] = await Promise.all([
    client
      .getSubjectEpisodes(subjectId, { type: 0, limit: 100, forceRefresh })
      .catch(() => ({ total: 0, limit: 100, offset: 0, data: [] })),
    client.getSubjectCharacters(subjectId, { forceRefresh }).catch(() => []),
    client.getSubjectRelations(subjectId, { forceRefresh }).catch(() => [])
  ]);

  const colRow = collectionDb
    .prepare('SELECT * FROM collection WHERE subject_id = ?')
    .get(subjectId) as CollectionRow | undefined;

  const epProgRows = collectionDb
    .prepare('SELECT episode_id, type FROM episode_progress WHERE subject_id = ?')
    .all(subjectId) as Array<{ episode_id: number; type: number }>;
  const watchedEpSet = new Set(epProgRows.filter((r) => r.type === 2).map((r) => r.episode_id));

  const { aliases, grouped: infoboxGrouped } = extractWikiV0Metadata(subject.infobox, [
    subject.name,
    subject.name_cn
  ]);

  const rawFav = subject.collection ?? {};
  const favorite = {
    wish: Number(rawFav.wish ?? 0) || 0,
    done: Number(rawFav.collect ?? 0) || 0,
    doing: Number(rawFav.doing ?? 0) || 0,
    on_hold: Number(rawFav.on_hold ?? 0) || 0,
    dropped: Number(rawFav.dropped ?? 0) || 0
  };

  const episodes = (epPage.data ?? []).map((ep) => ({
    id: ep.id,
    sort: ep.sort,
    type: ep.type,
    name: ep.name ?? '',
    nameCn: ep.name_cn ?? '',
    airdate: ep.airdate || null,
    duration: ep.duration || null,
    watched:
      watchedEpSet.has(ep.id) ||
      (ep.type === 0 && (colRow?.ep_status ?? 0) > 0 && ep.sort <= (colRow?.ep_status ?? 0))
  }));

  const characters = charList.slice(0, 16).map((ch) => ({
    id: ch.id,
    name: ch.name,
    roleType: ch.relation === '主角' ? 1 : ch.relation === '配角' ? 2 : 3,
    cvNames: Array.from(new Set((ch.actors ?? []).map((a) => a.name).filter(Boolean)))
  }));

  const relations = relList.slice(0, 20).map((rel) => ({
    relatedId: rel.id,
    relationLabel: rel.relation || '关联',
    name: rel.name,
    nameCn: rel.name_cn ?? '',
    typeLabel: getSubjectTypeLabel(rel.type),
    score: null
  }));

  const cachedMeta = readApiCache<BangumiSubjectDetail>(collectionDb, `subject:${subjectId}`, true);
  const refreshedAt = cachedMeta
    ? new Date(cachedMeta.fetchedAt).toISOString()
    : new Date().toISOString();

  return {
    id: subject.id,
    type: subject.type,
    typeLabel: getSubjectTypeLabel(subject.type),
    platform: null,
    platformLabel: normalizePlatformLabel(subject.platform, subject.type),
    name: subject.name,
    nameCn: subject.name_cn ?? '',
    aliases,
    date: subject.date ?? null,
    score:
      typeof subject.rating?.score === 'number' && subject.rating.score > 0
        ? subject.rating.score
        : null,
    rank:
      typeof subject.rating?.rank === 'number' && subject.rating.rank > 0
        ? subject.rating.rank
        : null,
    summary: subject.summary ?? '',
    favorite,
    tags: Array.isArray(subject.tags) ? subject.tags.slice(0, 20) : [],
    metaTags: Array.isArray(subject.meta_tags) ? subject.meta_tags : [],
    infobox: infoboxGrouped,
    episodes,
    characters,
    relations,
    myCollection: {
      type: colRow?.type ?? 0,
      typeLabel: colRow?.type ? COLLECTION_TYPE_NAMES[colRow.type] ?? '已收藏' : '未收藏',
      rate: colRow?.rate ?? 0,
      epStatus: colRow?.ep_status ?? 0,
      comment: colRow?.comment ?? '',
      tags: safeParseJson<string[]>(colRow?.tags, []),
      updatedAt: colRow?.updated_at ?? ''
    },
    refreshedAt
  };
}
