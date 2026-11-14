import type { BangumiClient, BangumiSubjectDetail, WikiV0Item } from './api/client.js';
import { getSubjectTypeLabel, normalizePlatformLabel } from './db/constants.js';

export interface SearchOptions {
  type?: number;
  platform?: number;
  sort?: 'match' | 'heat' | 'rank' | 'score';
  includeNsfw?: boolean;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}

export interface SubjectTag {
  name: string;
  count: number;
}

export interface SearchHit {
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
  favTotal: number;
  favDoing: number;
  favDone: number;
  favWish: number;
  nsfw: boolean;
  summary: string;
  tags: SubjectTag[];
  metaTags: string[];
  relevance: number;
}

const ALIAS_KEYS = new Set([
  '别名',
  '中文名',
  '简体中文名',
  '繁体中文名',
  '第二中文名',
  '英文名',
  '英文名二',
  '日文名',
  '罗马字',
  '纯假名',
  '昵称',
  '简称',
  '译名',
  '其他译名',
  '其他名称',
  '其他名义'
]);

const STUDIO_KEYS = new Set(['动画制作', '制作', '製作']);

export function extractWikiV0Metadata(
  infobox: WikiV0Item[] | undefined,
  excludeNames?: readonly string[]
): {
  aliases: string[];
  grouped: Array<{ key: string; values: string[] }>;
  studio: string;
  epsCount: number;
} {
  if (!Array.isArray(infobox) || infobox.length === 0) {
    return { aliases: [], grouped: [], studio: '', epsCount: 0 };
  }

  const excluded = new Set(
    (excludeNames ?? []).map((x) => x.trim()).filter((x) => x.length > 0)
  );
  const aliasSet = new Set<string>();
  const groupedMap = new Map<string, string[]>();
  let studio = '';
  let epsCount = 0;

  for (const item of infobox) {
    const key = (item?.key ?? '').trim();
    if (!key) continue;

    const values: string[] = [];
    if (typeof item.value === 'string') {
      const val = item.value.trim();
      if (val) {
        values.push(val);
        if (ALIAS_KEYS.has(key) && !excluded.has(val)) {
          aliasSet.add(val);
        }
      }
    } else if (Array.isArray(item.value)) {
      for (const sub of item.value) {
        const val = (sub?.v ?? '').trim();
        if (!val) continue;
        const subKey = sub?.k ? sub.k.trim() : '';
        values.push(subKey ? `${subKey}: ${val}` : val);
        if (ALIAS_KEYS.has(key) || (subKey && ALIAS_KEYS.has(subKey))) {
          if (!excluded.has(val)) {
            aliasSet.add(val);
          }
        }
      }
    }

    if (values.length > 0) {
      const prev = groupedMap.get(key) ?? [];
      prev.push(...values);
      groupedMap.set(key, prev);

      if (!studio && STUDIO_KEYS.has(key)) {
        studio = values[0];
      }
      if (!epsCount && key === '话数') {
        const parsed = parseInt(values[0], 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          epsCount = parsed;
        }
      }
    }
  }

  const grouped = Array.from(groupedMap.entries()).map(([key, values]) => ({ key, values }));
  return {
    aliases: Array.from(aliasSet),
    grouped,
    studio,
    epsCount
  };
}

export function mapSubjectToSearchHit(
  s: BangumiSubjectDetail,
  indexRank = 0,
  kwLower = ''
): SearchHit {
  const { aliases } = extractWikiV0Metadata(s.infobox, [s.name, s.name_cn]);
  const wish = Number(s.collection?.wish ?? 0) || 0;
  const done = Number(s.collection?.collect ?? 0) || 0;
  const doing = Number(s.collection?.doing ?? 0) || 0;
  const onHold = Number(s.collection?.on_hold ?? 0) || 0;
  const dropped = Number(s.collection?.dropped ?? 0) || 0;
  const favTotal = wish + done + doing + onHold + dropped;

  const score =
    typeof s.rating?.score === 'number' && s.rating.score > 0 ? s.rating.score : null;
  const rank =
    typeof s.rating?.rank === 'number' && s.rating.rank > 0 ? s.rating.rank : null;

  const platformLabel = normalizePlatformLabel(s.platform, s.type);

  const nameLower = (s.name ?? '').toLowerCase();
  const nameCnLower = (s.name_cn ?? '').toLowerCase();
  const aliasMatched = kwLower
    ? aliases.some((a) => a.toLowerCase() === kwLower || a.toLowerCase().includes(kwLower))
    : false;

  let bonus = Math.max(0, 30 - indexRank * 1.2);
  if (kwLower) {
    if (nameLower === kwLower || nameCnLower === kwLower) bonus += 90;
    else if (aliases.some((a) => a.toLowerCase() === kwLower)) bonus += 80;
    else if (nameLower.startsWith(kwLower) || nameCnLower.startsWith(kwLower)) bonus += 40;
    else if (aliasMatched) bonus += 25;
  }
  const composite =
    bonus +
    (score ?? 0) * 2.0 +
    (rank ? 4000 / (200 + rank) : 0) +
    Math.log1p(favTotal) * 2.5;

  return {
    id: s.id,
    type: s.type,
    typeLabel: getSubjectTypeLabel(s.type),
    platform: null,
    platformLabel,
    name: s.name ?? '',
    nameCn: s.name_cn ?? '',
    aliases,
    date: s.date ?? null,
    score,
    rank,
    favTotal,
    favDoing: doing,
    favDone: done,
    favWish: wish,
    nsfw: Boolean(s.nsfw),
    summary: s.summary ?? '',
    tags: Array.isArray(s.tags) ? s.tags.slice(0, 15) : [],
    metaTags: Array.isArray(s.meta_tags) ? s.meta_tags : [],
    relevance: Number(composite.toFixed(2))
  };
}

/**
 * 在线检索 Bangumi v0 条目（POST /v0/search/subjects + 本地轻量 TTL 缓存）
 */
export async function searchSubjectsOnline(
  client: BangumiClient,
  rawQuery: string,
  options?: SearchOptions
): Promise<SearchHit[]> {
  const kw = rawQuery.trim();
  if (!kw) return [];

  const limit = Math.max(1, Math.min(options?.limit ?? 25, 50));
  const offset = Math.max(0, options?.offset ?? 0);
  const platformTagMap: Record<number, string> = {
    1: 'TV',
    2: 'OVA',
    3: '剧场版',
    5: 'WEB'
  };
  const metaTags =
    options?.platform !== undefined && platformTagMap[options.platform]
      ? [platformTagMap[options.platform]]
      : undefined;

  const page = await client.searchSubjects({
    keyword: kw,
    sort: options?.sort ?? 'match',
    types: options?.type !== undefined ? [options.type] : undefined,
    metaTags,
    includeNsfw: options?.includeNsfw ?? false,
    limit,
    offset,
    forceRefresh: options?.forceRefresh
  });

  const kwLower = kw.toLowerCase();
  const hits = (page.data ?? []).map((item, idx) => mapSubjectToSearchHit(item, idx, kwLower));

  if (!options?.sort || options.sort === 'match') {
    hits.sort((a, b) => b.relevance - a.relevance || b.favTotal - a.favTotal);
  }
  return hits;
}
