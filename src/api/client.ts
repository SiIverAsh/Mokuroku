import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { BGM_API_BASE_URL, USER_AGENT, ensureDir, getAppPaths } from '../config.js';
import {
  AuthRequiredError,
  EnvPersonalTokenProvider,
  TokenExpiredError,
  type TokenProvider
} from './auth.js';

export { AuthRequiredError, EnvPersonalTokenProvider, TokenExpiredError, type TokenProvider };

export interface UserCollectionItem {
  subject_id: number;
  subject_type: number;
  rate: number;
  type: number; // 1=想看, 2=看过, 3=在看, 4=搁置, 5=抛弃
  comment?: string | null;
  tags: string[];
  ep_status: number;
  vol_status: number;
  updated_at: string;
  private: boolean;
  subject?: {
    id: number;
    type: number;
    name: string;
    name_cn: string;
    short_summary?: string;
    date?: string | null;
    eps?: number;
    volumes?: number;
    score?: number;
    rank?: number;
    collection_total?: number;
    tags?: Array<{ name: string; count: number }>;
  };
}

export interface PagedResponse<T> {
  total: number;
  limit: number;
  offset: number;
  data: T[];
}

export interface UpdateCollectionPayload {
  type?: number; // 1..5
  rate?: number; // 0..10
  ep_status?: number;
  vol_status?: number;
  comment?: string;
  private?: boolean;
  tags?: string[];
}

export interface UserEpisodeCollectionItem {
  episode: {
    id: number;
    type: number;
    name: string;
    name_cn: string;
    sort: number;
    ep?: number;
    airdate: string;
    comment?: number;
    duration?: string;
    desc?: string;
    disc?: number;
  };
  type: number; // 0=未收藏, 1=想看, 2=看过, 3=抛弃
  updated_at?: number | string;
}

export interface CalendarDay {
  weekday: {
    en: string;
    cn: string;
    ja: string;
    id: number;
  };
  items: Array<{
    id: number;
    url?: string;
    type: number;
    name: string;
    name_cn: string;
    summary?: string;
    air_date?: string;
    air_weekday?: number;
    rating?: {
      total?: number;
      score?: number;
      count?: Record<string, number>;
    };
    rank?: number;
    images?: {
      large?: string;
      common?: string;
      medium?: string;
      small?: string;
      grid?: string;
    };
    collection?: {
      doing?: number;
    };
  }>;
}

export interface BangumiSubjectDetail {
  id: number;
  type: number;
  name: string;
  name_cn: string;
  summary: string;
  nsfw: boolean;
  locked?: boolean;
  date?: string | null;
  platform?: string;
  eps?: number;
  total_episodes?: number;
  rating?: {
    rank?: number;
    total?: number;
    score?: number;
    count?: Record<string, number>;
  };
  collection?: {
    wish?: number;
    collect?: number;
    doing?: number;
    on_hold?: number;
    dropped?: number;
  };
  tags?: Array<{ name: string; count: number }>;
  meta_tags?: string[];
  infobox?: Array<{ key: string; value: unknown }>;
}

export interface BangumiClientOptions {
  baseUrl?: string;
  tokenProvider?: TokenProvider;
  username?: string;
  coversDir?: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterMs(headerValue: string | null, fallbackMs: number): number {
  if (!headerValue) return fallbackMs;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return fallbackMs;
}

export class BangumiApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly responseBody: string;

  constructor(status: number, url: string, responseBody: string) {
    super(`Bangumi API 请求失败 (${status}) ${url}: ${responseBody.slice(0, 240)}`);
    this.name = 'BangumiApiError';
    this.status = status;
    this.url = url;
    this.responseBody = responseBody;
  }
}

export class BangumiClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly username: string;
  private readonly coversDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;

  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestCompletedAt = 0;
  private resolvedUsername: string | null = null;

  constructor(options?: BangumiClientOptions) {
    const paths = getAppPaths();
    this.baseUrl = (options?.baseUrl ?? BGM_API_BASE_URL).replace(/\/+$/, '');
    this.tokenProvider = options?.tokenProvider ?? new EnvPersonalTokenProvider();
    this.username = (options?.username ?? process.env.BGM_USERNAME ?? '-').trim() || '-';
    this.coversDir = options?.coversDir ?? paths.coversDir;
    this.fetchFn = options?.fetchImpl ?? fetch;
    this.minIntervalMs = options?.minIntervalMs ?? 150;
    this.maxRetries = options?.maxRetries ?? 3;
    this.backoffBaseMs = options?.backoffBaseMs ?? 1000;
  }

  /**
   * 串行请求调度器：保证同一客户端绝不并发请求 Bangumi API。
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const elapsed = Date.now() - this.lastRequestCompletedAt;
      if (this.lastRequestCompletedAt > 0 && elapsed < this.minIntervalMs) {
        await sleep(this.minIntervalMs - elapsed);
      }
      try {
        return await fn();
      } finally {
        this.lastRequestCompletedAt = Date.now();
      }
    };

    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async requestRaw(
    pathAndQuery: string,
    init: {
      method?: 'GET' | 'POST';
      auth: 'required' | 'optional' | 'none';
      body?: unknown;
      accept?: string;
      timeoutMs?: number;
    }
  ): Promise<Response> {
    const url = `${this.baseUrl}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;

    return this.enqueue(async () => {
      let token: string | null = null;
      if (init.auth === 'required') {
        token = await this.tokenProvider.requireAccessToken();
      } else if (init.auth === 'optional') {
        token = await this.tokenProvider.getAccessToken();
      }

      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: init.accept ?? 'application/json'
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      if (init.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const res = await this.fetchFn(url, {
          method: init.method ?? 'GET',
          headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          redirect: 'follow',
          signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined
        });

        if (res.status === 401) {
          const detail = await res.text().catch(() => '');
          throw new TokenExpiredError(detail.slice(0, 120));
        }

        if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
          if (attempt < this.maxRetries) {
            const fallbackDelay = this.backoffBaseMs * Math.pow(2, attempt);
            const waitMs = parseRetryAfterMs(res.headers.get('retry-after'), fallbackDelay);
            await sleep(waitMs);
            continue;
          }
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new BangumiApiError(res.status, url, text);
        }

        return res;
      }

      throw new Error(`Bangumi API 重试次数耗尽: ${url}`);
    });
  }

  /**
   * GET /v0/users/-/collections (若远端对 '-' 返回 404 则自动通过 /v0/me 解析真实 username 重试)
   */
  async listCollections(params?: {
    subjectType?: number;
    type?: number;
    limit?: number;
    offset?: number;
  }): Promise<PagedResponse<UserCollectionItem>> {
    const search = new URLSearchParams();
    if (params?.subjectType !== undefined) search.set('subject_type', String(params.subjectType));
    if (params?.type !== undefined) search.set('type', String(params.type));
    search.set('limit', String(params?.limit ?? 50));
    search.set('offset', String(params?.offset ?? 0));

    const effectiveUser = this.resolvedUsername ?? this.username;
    const qs = search.toString();

    try {
      const res = await this.requestRaw(
        `/v0/users/${encodeURIComponent(effectiveUser)}/collections${qs ? `?${qs}` : ''}`,
        { auth: 'required' }
      );
      return (await res.json()) as PagedResponse<UserCollectionItem>;
    } catch (err) {
      if (
        err instanceof BangumiApiError &&
        err.status === 404 &&
        effectiveUser === '-' &&
        !this.resolvedUsername
      ) {
        const meRes = await this.requestRaw('/v0/me', { auth: 'required' });
        const me = (await meRes.json()) as { username?: string; id?: number };
        const detected = (me.username && String(me.username).trim()) || (me.id ? String(me.id) : '');
        if (detected) {
          this.resolvedUsername = detected;
          const retryRes = await this.requestRaw(
            `/v0/users/${encodeURIComponent(detected)}/collections${qs ? `?${qs}` : ''}`,
            { auth: 'required' }
          );
          return (await retryRes.json()) as PagedResponse<UserCollectionItem>;
        }
      }
      throw err;
    }
  }

  /**
   * POST /v0/users/-/collections/{subject_id}
   */
  async updateCollection(subjectId: number, payload: UpdateCollectionPayload): Promise<void> {
    await this.requestRaw(`/v0/users/-/collections/${subjectId}`, {
      method: 'POST',
      auth: 'required',
      body: payload
    });
  }

  /**
   * GET /v0/users/-/collections/{subject_id}/episodes
   */
  async getSubjectEpisodeProgress(
    subjectId: number,
    params?: { episodeType?: number; limit?: number; offset?: number }
  ): Promise<{ total: number; limit: number; offset: number; data: UserEpisodeCollectionItem[] }> {
    const search = new URLSearchParams();
    if (params?.episodeType !== undefined) search.set('episode_type', String(params.episodeType));
    search.set('limit', String(params?.limit ?? 100));
    search.set('offset', String(params?.offset ?? 0));

    const res = await this.requestRaw(
      `/v0/users/-/collections/${subjectId}/episodes?${search.toString()}`,
      { auth: 'required' }
    );
    return (await res.json()) as {
      total: number;
      limit: number;
      offset: number;
      data: UserEpisodeCollectionItem[];
    };
  }

  /**
   * GET /calendar
   */
  async getCalendar(): Promise<CalendarDay[]> {
    const res = await this.requestRaw('/calendar', { auth: 'none' });
    return (await res.json()) as CalendarDay[];
  }

  /**
   * GET /v0/subjects/{id} （单条目强制刷新）
   */
  async getSubject(subjectId: number): Promise<BangumiSubjectDetail> {
    const res = await this.requestRaw(`/v0/subjects/${subjectId}`, { auth: 'optional' });
    return (await res.json()) as BangumiSubjectDetail;
  }

  /**
   * GET /v0/subjects/{id}/image?type=common
   * 本地按 cache/covers/{id}.jpg 缓存，命中即不发网络请求。
   */
  async getCoverImage(
    subjectId: number,
    imageType: 'small' | 'grid' | 'large' | 'medium' | 'common' = 'common'
  ): Promise<{ filePath: string; buffer: Buffer; fromCache: boolean; contentType: string }> {
    const safeId = Math.trunc(Number(subjectId));
    if (!Number.isInteger(safeId) || safeId <= 0) {
      throw new Error(`无效的 subjectId: ${subjectId}`);
    }

    ensureDir(this.coversDir);
    const coverPath = resolve(this.coversDir, `${safeId}.jpg`);

    if (existsSync(coverPath) && statSync(coverPath).size > 0) {
      return {
        filePath: coverPath,
        buffer: readFileSync(coverPath),
        fromCache: true,
        contentType: 'image/jpeg'
      };
    }

    const res = await this.requestRaw(`/v0/subjects/${safeId}/image?type=${imageType}`, {
      auth: 'none',
      accept: 'image/*',
      timeoutMs: 4000
    });

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length > 0) {
      const tmpPath = `${coverPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, buffer);
      try {
        renameSync(tmpPath, coverPath);
      } catch {
        rmSync(tmpPath, { force: true });
      }
    }

    return {
      filePath: coverPath,
      buffer,
      fromCache: false,
      contentType: res.headers.get('content-type') ?? 'image/jpeg'
    };
  }

  /**
   * 全量拉取个人收藏并增量落盘至独立 collection.db（支持分页与在看番剧章节进度同步）
   */
  async pullAllCollectionsToDb(
    collectionDb: Database.Database,
    options?: {
      subjectTypes?: number[];
      includeWatchingEpisodes?: boolean;
      onProgress?: (pulled: number, total: number, subjectType: number) => void;
    }
  ): Promise<{ totalSaved: number; episodesSyncedSubjects: number }> {
    const subjectTypes = options?.subjectTypes ?? [2];
    const includeEpisodes = options?.includeWatchingEpisodes ?? true;

    const upsertCollection = collectionDb.prepare(`
      INSERT INTO collection (
        subject_id, subject_type, type, rate, ep_status, vol_status,
        comment, tags, private, updated_at,
        subject_name, subject_name_cn, subject_eps, subject_date, subject_score
      ) VALUES (
        @subject_id, @subject_type, @type, @rate, @ep_status, @vol_status,
        @comment, @tags, @private, @updated_at,
        @subject_name, @subject_name_cn, @subject_eps, @subject_date, @subject_score
      )
      ON CONFLICT(subject_id) DO UPDATE SET
        subject_type = excluded.subject_type,
        type = excluded.type,
        rate = excluded.rate,
        ep_status = excluded.ep_status,
        vol_status = excluded.vol_status,
        comment = excluded.comment,
        tags = excluded.tags,
        private = excluded.private,
        updated_at = excluded.updated_at,
        subject_name = CASE WHEN excluded.subject_name != '' THEN excluded.subject_name ELSE collection.subject_name END,
        subject_name_cn = CASE WHEN excluded.subject_name_cn != '' THEN excluded.subject_name_cn ELSE collection.subject_name_cn END,
        subject_eps = CASE WHEN excluded.subject_eps > 0 THEN excluded.subject_eps ELSE collection.subject_eps END,
        subject_date = COALESCE(excluded.subject_date, collection.subject_date),
        subject_score = COALESCE(excluded.subject_score, collection.subject_score)
    `);

    const writePageTx = collectionDb.transaction((items: UserCollectionItem[]) => {
      for (const item of items) {
        upsertCollection.run({
          subject_id: item.subject_id,
          subject_type: item.subject_type ?? item.subject?.type ?? 2,
          type: item.type,
          rate: item.rate ?? 0,
          ep_status: item.ep_status ?? 0,
          vol_status: item.vol_status ?? 0,
          comment: item.comment ?? '',
          tags: JSON.stringify(Array.isArray(item.tags) ? item.tags : []),
          private: item.private ? 1 : 0,
          updated_at: item.updated_at ?? new Date().toISOString(),
          subject_name: item.subject?.name ?? '',
          subject_name_cn: item.subject?.name_cn ?? '',
          subject_eps: item.subject?.eps ?? 0,
          subject_date: item.subject?.date ?? null,
          subject_score: item.subject?.score ?? null
        });
      }
    });

    let totalSaved = 0;
    const watchingSubjectIds: number[] = [];

    for (const st of subjectTypes) {
      let offset = 0;
      const limit = 50;
      for (;;) {
        const page = await this.listCollections({
          subjectType: st,
          limit,
          offset
        });

        if (page.data.length === 0) break;

        writePageTx(page.data);
        totalSaved += page.data.length;
        for (const item of page.data) {
          if (item.type === 3) {
            watchingSubjectIds.push(item.subject_id);
          }
        }

        offset += page.data.length;
        options?.onProgress?.(Math.min(offset, page.total || offset), page.total || offset, st);

        if (page.total > 0 && offset >= page.total) break;
        if (page.data.length < limit) break;
      }
    }

    let episodesSyncedSubjects = 0;
    if (includeEpisodes && watchingSubjectIds.length > 0) {
      for (const subjectId of watchingSubjectIds) {
        await this.syncSubjectEpisodesToDb(collectionDb, subjectId);
        episodesSyncedSubjects += 1;
      }
    }

    collectionDb
      .prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)')
      .run('last_collection_sync', new Date().toISOString());

    return { totalSaved, episodesSyncedSubjects };
  }

  async syncSubjectEpisodesToDb(
    collectionDb: Database.Database,
    subjectId: number
  ): Promise<number> {
    const upsertEp = collectionDb.prepare(`
      INSERT OR REPLACE INTO episode_progress (
        subject_id, episode_id, type, sort, ep_type, name, name_cn, airdate, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const writeTx = collectionDb.transaction((items: UserEpisodeCollectionItem[]) => {
      for (const item of items) {
        if (!item.episode?.id) continue;
        upsertEp.run(
          subjectId,
          item.episode.id,
          item.type ?? 0,
          item.episode.sort ?? 0,
          item.episode.type ?? 0,
          item.episode.name ?? '',
          item.episode.name_cn ?? '',
          item.episode.airdate ?? '',
          String(item.updated_at ?? '')
        );
      }
    });

    let offset = 0;
    const limit = 100;
    let synced = 0;
    for (;;) {
      const page = await this.getSubjectEpisodeProgress(subjectId, { limit, offset });
      if (page.data.length === 0) break;
      writeTx(page.data);
      synced += page.data.length;
      offset += page.data.length;
      if (page.total > 0 && offset >= page.total) break;
      if (page.data.length < limit) break;
    }
    return synced;
  }

  async syncCalendarToDb(collectionDb: Database.Database): Promise<CalendarDay[]> {
    const days = await this.getCalendar();
    const fetchedAt = new Date().toISOString();

    const clearStmt = collectionDb.prepare('DELETE FROM calendar_cache');
    const insertStmt = collectionDb.prepare(`
      INSERT OR REPLACE INTO calendar_cache (
        weekday_id, subject_id, name, name_cn, air_date, score, rank, images_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = collectionDb.transaction(() => {
      clearStmt.run();
      for (const day of days) {
        const wid = day.weekday?.id ?? 0;
        if (!wid) continue;
        for (const item of day.items ?? []) {
          insertStmt.run(
            wid,
            item.id,
            item.name ?? '',
            item.name_cn ?? '',
            item.air_date ?? null,
            item.rating?.score ?? null,
            item.rank ?? null,
            item.images ? JSON.stringify(item.images) : null,
            fetchedAt
          );
        }
      }
      collectionDb
        .prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)')
        .run('last_calendar_sync', fetchedAt);
    });
    tx();
    return days;
  }

  async refreshSubjectToDb(
    collectionDb: Database.Database,
    subjectId: number
  ): Promise<BangumiSubjectDetail> {
    const detail = await this.getSubject(subjectId);
    const fetchedAt = new Date().toISOString();
    collectionDb
      .prepare(
        'INSERT OR REPLACE INTO subject_override (subject_id, payload_json, fetched_at) VALUES (?, ?, ?)'
      )
      .run(subjectId, JSON.stringify(detail), fetchedAt);
    return detail;
  }
}
