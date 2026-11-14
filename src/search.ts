import type Database from 'better-sqlite3';
import { getPlatformLabel, getSubjectTypeLabel } from './db/constants.js';

export interface SearchOptions {
  type?: number;
  platform?: number;
  includeNsfw?: boolean;
  limit?: number;
  offset?: number;
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

/**
 * 将用户输入转义为安全的 FTS5 MATCH 短语表达式（所有查询一律走 better_trigram MATCH，不回退 LIKE）。
 */
export function buildFtsMatchQuery(rawQuery: string): string {
  const tokens = rawQuery
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return '';
  }

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

interface RawSubjectRow {
  id: number;
  type: number;
  platform: number | null;
  name: string;
  name_cn: string;
  aliases: string;
  date: string | null;
  score: number | null;
  rank: number | null;
  fav_total: number;
  fav_doing: number;
  fav_done: number;
  fav_wish: number;
  nsfw: number;
  summary: string | null;
  tags: string | null;
  meta_tags: string | null;
  bm25_raw: number;
}

/**
 * 执行全文检索：
 * 1. 严格通过 subject_fts MATCH 检索中日英混排与 1~2 字短词（sqlite-better-trigram）
 * 2. 综合标题/中文名/别名精确与前缀匹配度、BM25、score、rank、收藏总数排序
 */
export function searchSubjects(
  db: Database.Database,
  rawQuery: string,
  options?: SearchOptions
): SearchHit[] {
  const matchExpr = buildFtsMatchQuery(rawQuery);
  if (!matchExpr) return [];

  const limit = Math.max(1, Math.min(options?.limit ?? 20, 200));
  const offset = Math.max(0, options?.offset ?? 0);
  const includeNsfw = options?.includeNsfw ?? false;
  const normalizedKw = rawQuery.trim().toLowerCase();

  const conditions: string[] = ['subject_fts MATCH @matchExpr'];
  const params: Record<string, unknown> = {
    matchExpr,
    kwLower: normalizedKw,
    limit,
    offset
  };

  if (options?.type !== undefined) {
    conditions.push('s.type = @type');
    params.type = options.type;
  }
  if (options?.platform !== undefined) {
    conditions.push('s.platform = @platform');
    params.platform = options.platform;
  }
  if (!includeNsfw) {
    conditions.push('s.nsfw = 0');
  }

  // Composite ranking:
  // - Exact title / Chinese title / standalone alias token match gets top priority
  // - Title/name_cn substring match over pure tag-only match
  // - Weighted BM25 across (name=10, name_cn=10, aliases=8, tags=1.5)
  // - Bangumi score (0..10), inverse rank bonus, and log-scaled favorite count
  const sql = `
    SELECT
      s.id,
      s.type,
      s.platform,
      s.name,
      s.name_cn,
      s.aliases,
      s.date,
      s.score,
      s.rank,
      s.fav_total,
      s.fav_doing,
      s.fav_done,
      s.fav_wish,
      s.nsfw,
      s.summary,
      s.tags,
      s.meta_tags,
      bm25(subject_fts, 10.0, 10.0, 8.0, 1.5) AS bm25_raw,
      (
        CASE
          WHEN lower(s.name) = @kwLower OR lower(s.name_cn) = @kwLower THEN 120.0
          WHEN (' / ' || lower(s.aliases) || ' / ') LIKE ('% / ' || @kwLower || ' / %') THEN 105.0
          WHEN instr(lower(s.name), @kwLower) = 1 OR instr(lower(s.name_cn), @kwLower) = 1 THEN 65.0
          WHEN instr(lower(s.name), @kwLower) > 0 OR instr(lower(s.name_cn), @kwLower) > 0 THEN 42.0
          WHEN instr(lower(s.aliases), @kwLower) > 0 THEN 32.0
          ELSE 0.0
        END
        + MIN(40.0, (-bm25(subject_fts, 10.0, 10.0, 8.0, 1.5)))
        + COALESCE(s.score, 0.0) * 2.2
        + CASE
            WHEN s.rank IS NOT NULL AND s.rank > 0 THEN (6000.0 / (200.0 + s.rank))
            ELSE 0.0
          END
        + ln(1.0 + MAX(0, s.fav_total)) * 3.2
      ) AS composite_score
    FROM subject_fts f
    JOIN subject s ON s.id = f.rowid
    WHERE ${conditions.join(' AND ')}
    ORDER BY composite_score DESC, s.fav_total DESC, COALESCE(s.score, 0) DESC, s.id ASC
    LIMIT @limit OFFSET @offset
  `;

  const rows = db.prepare(sql).all(params) as Array<RawSubjectRow & { composite_score: number }>;

  return rows.map((r) => {
    let tags: SubjectTag[] = [];
    if (r.tags) {
      try {
        const parsed = JSON.parse(r.tags) as unknown[];
        if (Array.isArray(parsed)) {
          tags = parsed
            .filter(
              (t): t is SubjectTag =>
                Boolean(t && typeof t === 'object' && typeof (t as SubjectTag).name === 'string')
            )
            .slice(0, 15);
        }
      } catch {
        tags = [];
      }
    }

    let metaTags: string[] = [];
    if (r.meta_tags) {
      try {
        const parsed = JSON.parse(r.meta_tags) as unknown[];
        if (Array.isArray(parsed)) {
          metaTags = parsed.filter((t): t is string => typeof t === 'string');
        }
      } catch {
        metaTags = [];
      }
    }

    const aliases = r.aliases
      ? r.aliases
          .split(' / ')
          .map((a) => a.trim())
          .filter(Boolean)
      : [];

    return {
      id: r.id,
      type: r.type,
      typeLabel: getSubjectTypeLabel(r.type),
      platform: r.platform,
      platformLabel: getPlatformLabel(r.type, r.platform),
      name: r.name,
      nameCn: r.name_cn,
      aliases,
      date: r.date,
      score: r.score,
      rank: r.rank,
      favTotal: r.fav_total,
      favDoing: r.fav_doing,
      favDone: r.fav_done,
      favWish: r.fav_wish,
      nsfw: Boolean(r.nsfw),
      summary: r.summary ?? '',
      tags,
      metaTags,
      relevance: Number(r.composite_score.toFixed(2))
    };
  });
}
