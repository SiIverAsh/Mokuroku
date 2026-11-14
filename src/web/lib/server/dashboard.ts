import type Database from 'better-sqlite3';
import { loadDotEnv } from '../../../config.js';
import {
  COLLECTION_TYPE_NAMES,
  getPlatformLabel,
  getSubjectTypeLabel,
  loadBangumiCommonConstants
} from '../../../db/constants.js';
import { type SearchHit, searchSubjects } from '../../../search.js';

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
  hasArchive: boolean;
  renderMs: number;
  archiveSummary: {
    dumpName: string | null;
    dumpUpdatedAt: string | null;
    importedAt: string | null;
    subjectCount: number;
    episodeCount: number;
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
  const month = now.getMonth() + 1; // 1..12
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

export function getSeasonDateRange(seasonCode: string): { startDate: string; endDate: string } {
  const m = /^(\d{4})-(01|04|07|10)$/.exec(seasonCode.trim());
  if (!m) {
    return getSeasonDateRange(getCurrentSeasonCode());
  }
  const year = Number(m[1]);
  const q = m[2];
  // 日本新番常在季度前一周（如 9 月下旬开播 10 月番《葬送的芙莉莲》2023-09-29）首播，按季度放送窗口切分且互不重叠
  switch (q) {
    case '01':
      return { startDate: `${year - 1}-12-25`, endDate: `${year}-03-24` };
    case '04':
      return { startDate: `${year}-03-25`, endDate: `${year}-06-24` };
    case '07':
      return { startDate: `${year}-06-25`, endDate: `${year}-09-24` };
    case '10':
    default:
      return { startDate: `${year}-09-25`, endDate: `${year}-12-24` };
  }
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
}

interface ArchiveSubjectMini {
  id: number;
  type: number;
  platform: number | null;
  name: string;
  name_cn: string;
  date: string | null;
  score: number | null;
  score_details: string | null;
  rank: number | null;
  tags: string | null;
  meta_tags: string | null;
  fav_total: number;
  fav_doing: number;
}

export function getDashboardData(
  archiveDb: Database.Database | null,
  collectionDb: Database.Database,
  params?: {
    season?: string;
    platform?: number | null;
    q?: string;
    searchType?: number | null;
    now?: Date;
  }
): DashboardData {
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
  }

  if (stats.ratedCount > 0) {
    stats.myAvgScore = Number((myRateSum / stats.ratedCount).toFixed(2));
  }

  if (!archiveDb) {
    const emptyDist: ScoreBucket[] = [];
    for (let s = 10; s >= 1; s--) {
      emptyDist.push({
        score: s,
        myCount: myBuckets[s],
        myPct: stats.ratedCount > 0 ? Number(((myBuckets[s] / stats.ratedCount) * 100).toFixed(1)) : 0,
        siteCount: 0,
        sitePct: 0
      });
    }
    return {
      hasArchive: false,
      renderMs: Number((performance.now() - t0).toFixed(2)),
      archiveSummary: {
        dumpName: null,
        dumpUpdatedAt: null,
        importedAt: null,
        subjectCount: 0,
        episodeCount: 0,
        lastCollectionSync: syncMap.get('last_collection_sync') ?? null,
        lastCalendarSync: syncMap.get('last_calendar_sync') ?? null,
        tokenConfigured
      },
      collectionStats: stats,
      scoreDistribution: emptyDist,
      scoreDistributionBasis: 'my_collection',
      watchingList: [],
      seasonFilter: {
        current: currentSeason,
        platform: platformFilter,
        options: seasonOptions
      },
      seasonalAnime: [],
      tasteTags: [],
      recommendations: [],
      searchQuery: params?.q ?? '',
      searchType: params?.searchType ?? null,
      searchResults: []
    };
  }

  // Archive metadata (fast primary-key table)
  const metaRows = archiveDb.prepare('SELECT key, value FROM archive_meta').all() as Array<{
    key: string;
    value: string;
  }>;
  const metaMap = new Map(metaRows.map((r) => [r.key, r.value]));
  const rowCountsObj = safeParseJson<Record<string, number>>(metaMap.get('row_counts'), {});
  const subjectCount =
    rowCountsObj.subject ??
    ((archiveDb.prepare('SELECT COUNT(*) AS c FROM subject').get() as { c: number }).c || 0);
  const episodeCount = rowCountsObj.episode ?? 0;

  // Fetch archive subject rows for all collected items in batches of 400
  const archiveBySubjectId = new Map<number, ArchiveSubjectMini>();
  if (collections.length > 0) {
    const ids = collections.map((c) => c.subject_id);
    const chunkSize = 400;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const slice = ids.slice(i, i + chunkSize);
      const placeholders = slice.map(() => '?').join(',');
      const rows = archiveDb
        .prepare(
          `SELECT id, type, platform, name, name_cn, date, score, score_details, rank, tags, meta_tags, fav_total, fav_doing
           FROM subject WHERE id IN (${placeholders})`
        )
        .all(...slice) as ArchiveSubjectMini[];
      for (const r of rows) {
        archiveBySubjectId.set(r.id, r);
      }
    }
  }

  // 2. Site score distribution (on collected subjects if available, else top-500 anime benchmark)
  const siteBuckets = new Array<number>(11).fill(0);
  let siteVoteTotal = 0;
  let siteScoreSum = 0;
  let siteScoreCnt = 0;
  let scoreDistributionBasis: 'my_collection' | 'site_top_benchmark' = 'my_collection';

  if (archiveBySubjectId.size > 0) {
    for (const c of collections) {
      const s = archiveBySubjectId.get(c.subject_id);
      if (!s) continue;
      if (typeof s.score === 'number' && s.score > 0) {
        siteScoreSum += s.score;
        siteScoreCnt += 1;
      }
      const details = safeParseJson<Record<string, number>>(s.score_details, {});
      for (let k = 1; k <= 10; k++) {
        const v = Number(details[String(k)] ?? 0) || 0;
        siteBuckets[k] += v;
        siteVoteTotal += v;
      }
    }
  } else {
    scoreDistributionBasis = 'site_top_benchmark';
    const benchRows = archiveDb
      .prepare(
        `SELECT score, score_details FROM subject
         WHERE type = 2 AND nsfw = 0 AND rank IS NOT NULL AND rank > 0 AND rank <= 500`
      )
      .all() as Array<{ score: number | null; score_details: string | null }>;
    for (const b of benchRows) {
      if (typeof b.score === 'number' && b.score > 0) {
        siteScoreSum += b.score;
        siteScoreCnt += 1;
      }
      const details = safeParseJson<Record<string, number>>(b.score_details, {});
      for (let k = 1; k <= 10; k++) {
        const v = Number(details[String(k)] ?? 0) || 0;
        siteBuckets[k] += v;
        siteVoteTotal += v;
      }
    }
  }

  if (siteScoreCnt > 0) {
    stats.siteAvgScore = Number((siteScoreSum / siteScoreCnt).toFixed(2));
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

  // 3. Watching list + episode progress + next episode airdate
  const watchingCols = collections.filter((c) => c.type === 3);
  const getEpisodesStmt = archiveDb.prepare(`
    SELECT id, sort, name, name_cn, airdate
    FROM episode
    WHERE subject_id = ? AND type = 0
    ORDER BY sort ASC, id ASC
  `);
  const getInfoboxEpsStmt = archiveDb.prepare(`
    SELECT value FROM subject_infobox
    WHERE subject_id = ? AND key = '话数'
    LIMIT 1
  `);
  const getEpProgressStmt = collectionDb.prepare(`
    SELECT episode_id, type, sort
    FROM episode_progress
    WHERE subject_id = ?
  `);

  const watchingList: WatchingItem[] = watchingCols.map((c) => {
    const subj = archiveBySubjectId.get(c.subject_id);
    const episodes = getEpisodesStmt.all(c.subject_id) as Array<{
      id: number;
      sort: number;
      name: string;
      name_cn: string;
      airdate: string | null;
    }>;
    const epProgress = getEpProgressStmt.all(c.subject_id) as Array<{
      episode_id: number;
      type: number;
      sort: number | null;
    }>;

    const watchedEpIds = new Set(epProgress.filter((e) => e.type === 2).map((e) => e.episode_id));
    const watchedEps = Math.max(c.ep_status || 0, watchedEpIds.size);

    let totalEps = episodes.length;
    if (totalEps === 0) {
      const infoRow = getInfoboxEpsStmt.get(c.subject_id) as { value?: string } | undefined;
      const parsedInfoEps = infoRow?.value ? parseInt(infoRow.value, 10) : 0;
      totalEps = (Number.isFinite(parsedInfoEps) && parsedInfoEps > 0 ? parsedInfoEps : 0) || c.subject_eps || 0;
    }

    let nextEpRow: (typeof episodes)[number] | undefined;
    if (watchedEpIds.size > 0) {
      nextEpRow = episodes.find((ep) => !watchedEpIds.has(ep.id) && ep.sort > 0);
    }
    if (!nextEpRow && episodes.length > 0) {
      nextEpRow = episodes.find((ep) => ep.sort > watchedEps) ?? episodes[watchedEps];
    }

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

    return {
      subjectId: c.subject_id,
      name: subj?.name || c.subject_name || `#${c.subject_id}`,
      nameCn: subj?.name_cn || c.subject_name_cn || '',
      platformLabel: subj ? getPlatformLabel(subj.type, subj.platform) : 'TV',
      score: subj?.score ?? c.subject_score ?? null,
      myRate: c.rate,
      watchedEps,
      totalEps,
      progressPct,
      updatedAt: c.updated_at,
      nextEpisode
    };
  });

  // 4. Seasonal Anime (type = 2, filtered by date + platform)
  const { startDate, endDate } = getSeasonDateRange(currentSeason);
  const seasonalSql =
    platformFilter !== null
      ? `SELECT id, type, platform, name, name_cn, date, score, rank, fav_doing, fav_total, tags, meta_tags
         FROM subject
         WHERE type = 2 AND nsfw = 0 AND date >= @startDate AND date <= @endDate AND platform = @platform
         ORDER BY fav_doing DESC, fav_total DESC, COALESCE(score, 0) DESC
         LIMIT 50`
      : `SELECT id, type, platform, name, name_cn, date, score, rank, fav_doing, fav_total, tags, meta_tags
         FROM subject
         WHERE type = 2 AND nsfw = 0 AND date >= @startDate AND date <= @endDate
         ORDER BY fav_doing DESC, fav_total DESC, COALESCE(score, 0) DESC
         LIMIT 50`;

  const seasonalRows = archiveDb
    .prepare(seasonalSql)
    .all({ startDate, endDate, platform: platformFilter }) as Array<{
    id: number;
    type: number;
    platform: number | null;
    name: string;
    name_cn: string;
    date: string;
    score: number | null;
    rank: number | null;
    fav_doing: number;
    fav_total: number;
    tags: string | null;
    meta_tags: string | null;
  }>;

  const getStudioStmt = archiveDb.prepare(`
    SELECT value FROM subject_infobox
    WHERE subject_id = ? AND key IN ('动画制作', '制作', '製作')
    ORDER BY CASE key WHEN '动画制作' THEN 0 ELSE 1 END, ord ASC
    LIMIT 1
  `);

  const seasonalAnime: SeasonalAnimeItem[] = seasonalRows.map((r) => {
    const col = collectionBySubjectId.get(r.id);
    const studioRow = getStudioStmt.get(r.id) as { value?: string } | undefined;
    const rawTags = safeParseJson<Array<{ name: string; count: number }>>(r.tags, []);
    const cleanTags = rawTags
      .map((t) => t.name)
      .filter((n) => Boolean(n) && !isNoiseTag(n))
      .slice(0, 4);

    return {
      id: r.id,
      name: r.name,
      nameCn: r.name_cn,
      platform: r.platform,
      platformLabel: getPlatformLabel(r.type, r.platform) || '其他',
      date: r.date,
      score: r.score,
      rank: r.rank,
      favDoing: r.fav_doing,
      favTotal: r.fav_total,
      studio: studioRow?.value ?? '',
      tags: cleanTags,
      myCollectionType: col?.type ?? null,
      myRate: col?.rate ?? 0
    };
  });

  // 5. Personal Taste Profile (tag cloud aggregated from collected subjects' tags & meta_tags)
  const tagAgg = new Map<
    string,
    { count: number; weight: number; rateSum: number; rateCnt: number }
  >();

  for (const c of collections) {
    // Only aggregate positive/active interest: 想看(1), 看过(2), 在看(3)
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

    const subj = archiveBySubjectId.get(c.subject_id);
    if (subj) {
      const sTags = safeParseJson<Array<{ name: string; count: number }>>(subj.tags, []).slice(
        0,
        12
      );
      for (const st of sTags) {
        if (st?.name && !isNoiseTag(st.name)) perItemTags.add(st.name.trim());
      }
      const mTags = safeParseJson<string[]>(subj.meta_tags, []);
      for (const mt of mTags) {
        if (typeof mt === 'string' && !isNoiseTag(mt)) perItemTags.add(mt.trim());
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

  // Build normalized taste weight lookup for recommendations
  const maxTasteWeight = tasteTags[0]?.weight ?? 1;
  const topTasteMap = new Map<string, number>();
  for (const t of tasteTags.slice(0, 25)) {
    topTasteMap.set(t.name, t.weight / Math.max(1, maxTasteWeight));
  }

  // 6. High-Score Unwatched Recommendations (score 高 + rank 靠前 + 不在收藏里 + 标签匹配偏好)
  const candidateRows = archiveDb
    .prepare(
      `SELECT id, type, platform, name, name_cn, date, score, rank, fav_total, tags, meta_tags
       FROM subject
       WHERE type = 2 AND nsfw = 0 AND rank IS NOT NULL AND rank > 0 AND rank <= 1200 AND score >= 7.6
       ORDER BY rank ASC
       LIMIT 350`
    )
    .all() as Array<{
    id: number;
    type: number;
    platform: number | null;
    name: string;
    name_cn: string;
    date: string | null;
    score: number;
    rank: number;
    fav_total: number;
    tags: string | null;
    meta_tags: string | null;
  }>;

  const recommendations: RecommendationItem[] = [];
  for (const cand of candidateRows) {
    if (collectionBySubjectId.has(cand.id)) continue;

    const rawTags = safeParseJson<Array<{ name: string; count: number }>>(cand.tags, []).slice(
      0,
      14
    );
    const rawMeta = safeParseJson<string[]>(cand.meta_tags, []);
    const candTagSet = new Set<string>();
    const displayTags: string[] = [];

    for (const t of rawTags) {
      if (t?.name && !isNoiseTag(t.name)) {
        candTagSet.add(t.name.trim());
        if (displayTags.length < 4) displayTags.push(t.name.trim());
      }
    }
    for (const mt of rawMeta) {
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
      cand.score * 8.5 + (1300 - Math.min(1200, cand.rank)) * 0.02 + Math.log1p(cand.fav_total) * 0.8;
    const recScore = Number((qualityScore + affinityBonus).toFixed(2));

    recommendations.push({
      id: cand.id,
      name: cand.name,
      nameCn: cand.name_cn,
      platformLabel: getPlatformLabel(cand.type, cand.platform) || 'TV',
      date: cand.date,
      score: cand.score,
      rank: cand.rank,
      favTotal: cand.fav_total,
      matchedTags: matchedTags.slice(0, 4),
      topTags: displayTags,
      recScore
    });
  }

  recommendations.sort((a, b) => b.recScore - a.recScore || a.rank - b.rank);
  const topRecommendations = recommendations.slice(0, 24);

  // 7. Optional SSR search query
  const searchQuery = (params?.q ?? '').trim();
  const searchType =
    params?.searchType !== undefined && params.searchType !== null
      ? Number(params.searchType)
      : null;
  const searchResults = searchQuery
    ? searchSubjects(archiveDb, searchQuery, {
        type: searchType ?? undefined,
        limit: 30
      })
    : [];

  return {
    hasArchive: true,
    renderMs: Number((performance.now() - t0).toFixed(2)),
    archiveSummary: {
      dumpName: metaMap.get('dump_name') ?? null,
      dumpUpdatedAt: metaMap.get('dump_updated_at') ?? null,
      importedAt: metaMap.get('imported_at') ?? null,
      subjectCount,
      episodeCount,
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

export function getSubjectDrawerDetail(
  archiveDb: Database.Database | null,
  collectionDb: Database.Database,
  subjectId: number
): SubjectDrawerDetail | null {
  const overrideRow = collectionDb
    .prepare('SELECT payload_json, fetched_at FROM subject_override WHERE subject_id = ?')
    .get(subjectId) as { payload_json: string; fetched_at: string } | undefined;

  const colRow = collectionDb
    .prepare('SELECT * FROM collection WHERE subject_id = ?')
    .get(subjectId) as CollectionRow | undefined;

  const epProgRows = collectionDb
    .prepare('SELECT episode_id, type FROM episode_progress WHERE subject_id = ?')
    .all(subjectId) as Array<{ episode_id: number; type: number }>;
  const watchedEpSet = new Set(epProgRows.filter((r) => r.type === 2).map((r) => r.episode_id));

  const subjRow = archiveDb
    ? (archiveDb
        .prepare(
          `SELECT id, type, platform, name, name_cn, aliases, date, score, rank, summary, favorite, tags, meta_tags
           FROM subject WHERE id = ?`
        )
        .get(subjectId) as
        | {
            id: number;
            type: number;
            platform: number | null;
            name: string;
            name_cn: string;
            aliases: string;
            date: string | null;
            score: number | null;
            rank: number | null;
            summary: string | null;
            favorite: string | null;
            tags: string | null;
            meta_tags: string | null;
          }
        | undefined)
    : undefined;

  if (!subjRow && !overrideRow) {
    return null;
  }

  const override = overrideRow
    ? safeParseJson<Record<string, unknown>>(overrideRow.payload_json, {})
    : null;

  const type = Number(override?.type ?? subjRow?.type ?? 2);
  const platform = subjRow?.platform ?? null;
  const name = String(override?.name ?? subjRow?.name ?? '');
  const nameCn = String(override?.name_cn ?? subjRow?.name_cn ?? '');
  const date = (override?.date as string | null | undefined) ?? subjRow?.date ?? null;
  const ratingObj = override?.rating as { score?: number; rank?: number } | undefined;
  const score = ratingObj?.score ?? subjRow?.score ?? null;
  const rank = ratingObj?.rank ?? subjRow?.rank ?? null;
  const summary = String(override?.summary ?? subjRow?.summary ?? '');

  const rawFav =
    (override?.collection as Record<string, number> | undefined) ??
    safeParseJson<Record<string, number>>(subjRow?.favorite, {});
  const favorite = {
    wish: Number(rawFav.wish ?? 0) || 0,
    done: Number(rawFav.done ?? rawFav.collect ?? 0) || 0,
    doing: Number(rawFav.doing ?? rawFav.do ?? 0) || 0,
    on_hold: Number(rawFav.on_hold ?? 0) || 0,
    dropped: Number(rawFav.dropped ?? 0) || 0
  };

  const tags =
    (override?.tags as Array<{ name: string; count: number }> | undefined) ??
    safeParseJson<Array<{ name: string; count: number }>>(subjRow?.tags, []).slice(0, 20);
  const metaTags =
    (override?.meta_tags as string[] | undefined) ??
    safeParseJson<string[]>(subjRow?.meta_tags, []);

  // Infobox grouped by key
  const infoboxGrouped: Array<{ key: string; values: string[] }> = [];
  if (archiveDb) {
    const infoRows = archiveDb
      .prepare(
        'SELECT key, sub_key, value FROM subject_infobox WHERE subject_id = ? ORDER BY ord ASC'
      )
      .all(subjectId) as Array<{ key: string; sub_key: string | null; value: string }>;
    const map = new Map<string, string[]>();
    for (const r of infoRows) {
      const displayVal = r.sub_key ? `${r.sub_key}: ${r.value}` : r.value;
      const list = map.get(r.key) ?? [];
      list.push(displayVal);
      map.set(r.key, list);
    }
    for (const [key, values] of map.entries()) {
      infoboxGrouped.push({ key, values });
    }
  }

  // Episodes
  const episodes = archiveDb
    ? (
        archiveDb
          .prepare(
            `SELECT id, sort, type, name, name_cn, airdate, duration
             FROM episode WHERE subject_id = ?
             ORDER BY type ASC, sort ASC, id ASC
             LIMIT 200`
          )
          .all(subjectId) as Array<{
          id: number;
          sort: number;
          type: number;
          name: string;
          name_cn: string;
          airdate: string | null;
          duration: string | null;
        }>
      ).map((ep) => ({
        id: ep.id,
        sort: ep.sort,
        type: ep.type,
        name: ep.name,
        nameCn: ep.name_cn,
        airdate: ep.airdate,
        duration: ep.duration,
        watched:
          watchedEpSet.has(ep.id) ||
          (ep.type === 0 && (colRow?.ep_status ?? 0) > 0 && ep.sort <= (colRow?.ep_status ?? 0))
      }))
    : [];

  // Characters + CVs
  const characters: SubjectDrawerDetail['characters'] = [];
  if (archiveDb) {
    const charRows = archiveDb
      .prepare(
        `SELECT sc.character_id AS id, sc.type AS role_type, c.name
         FROM subject_character sc
         JOIN character c ON c.id = sc.character_id
         WHERE sc.subject_id = ?
         ORDER BY sc.type ASC, sc.ord ASC
         LIMIT 16`
      )
      .all(subjectId) as Array<{ id: number; role_type: number; name: string }>;

    const cvStmt = archiveDb.prepare(
      `SELECT p.name FROM person_character pc
       JOIN person p ON p.id = pc.person_id
       WHERE pc.subject_id = ? AND pc.character_id = ?`
    );

    for (const ch of charRows) {
      const cvs = (cvStmt.all(subjectId, ch.id) as Array<{ name: string }>).map((x) => x.name);
      characters.push({
        id: ch.id,
        name: ch.name,
        roleType: ch.role_type,
        cvNames: Array.from(new Set(cvs))
      });
    }
  }

  // Relations
  const relations: SubjectDrawerDetail['relations'] = [];
  if (archiveDb) {
    const { subjectRelations } = loadBangumiCommonConstants();
    const relRows = archiveDb
      .prepare(
        `SELECT sr.related_subject_id, sr.relation_type, s.name, s.name_cn, s.type, s.score
         FROM subject_relation sr
         JOIN subject s ON s.id = sr.related_subject_id
         WHERE sr.subject_id = ?
         ORDER BY sr.ord ASC
         LIMIT 20`
      )
      .all(subjectId) as Array<{
      related_subject_id: number;
      relation_type: number;
      name: string;
      name_cn: string;
      type: number;
      score: number | null;
    }>;

    for (const r of relRows) {
      const relConst =
        subjectRelations.find(
          (x) => x.subjectType === type && x.relationType === r.relation_type
        ) ?? subjectRelations.find((x) => x.relationType === r.relation_type);
      relations.push({
        relatedId: r.related_subject_id,
        relationLabel: relConst?.nameCn ?? `关联#${r.relation_type}`,
        name: r.name,
        nameCn: r.name_cn,
        typeLabel: getSubjectTypeLabel(r.type),
        score: r.score
      });
    }
  }

  const aliases = subjRow?.aliases
    ? subjRow.aliases
        .split(' / ')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    id: subjectId,
    type,
    typeLabel: getSubjectTypeLabel(type),
    platform,
    platformLabel: getPlatformLabel(type, platform),
    name,
    nameCn,
    aliases,
    date,
    score,
    rank,
    summary,
    favorite,
    tags,
    metaTags,
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
    refreshedAt: overrideRow?.fetched_at ?? null
  };
}
