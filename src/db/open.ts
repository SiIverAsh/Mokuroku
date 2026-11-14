import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ensureDir, getAppPaths } from '../config.js';

export const MAX_API_CACHE_ROWS = 400;

const COLLECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS collection (
  subject_id INTEGER PRIMARY KEY,
  subject_type INTEGER NOT NULL DEFAULT 2,
  type INTEGER NOT NULL,              -- 1=想看, 2=看过, 3=在看, 4=搁置, 5=抛弃
  rate INTEGER NOT NULL DEFAULT 0,    -- 0=未评分, 1..10
  ep_status INTEGER NOT NULL DEFAULT 0,
  vol_status INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',    -- 用户个人标签 JSON string[]
  private INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  subject_name TEXT NOT NULL DEFAULT '',
  subject_name_cn TEXT NOT NULL DEFAULT '',
  subject_eps INTEGER NOT NULL DEFAULT 0,
  subject_date TEXT,
  subject_score REAL,
  subject_rank INTEGER,
  subject_total INTEGER NOT NULL DEFAULT 0,
  subject_platform TEXT NOT NULL DEFAULT '',
  subject_tags_json TEXT NOT NULL DEFAULT '[]' -- 条目公共标签 JSON Array<{name, count}>
);

CREATE INDEX IF NOT EXISTS idx_collection_type ON collection(type);
CREATE INDEX IF NOT EXISTS idx_collection_subject_type ON collection(subject_type, type);
CREATE INDEX IF NOT EXISTS idx_collection_updated_at ON collection(updated_at DESC);

CREATE TABLE IF NOT EXISTS episode_progress (
  subject_id INTEGER NOT NULL,
  episode_id INTEGER NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,    -- 0=未收藏, 1=想看, 2=看过, 3=抛弃
  sort REAL,
  ep_type INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  name_cn TEXT NOT NULL DEFAULT '',
  airdate TEXT,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (subject_id, episode_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_progress_subject ON episode_progress(subject_id, sort);

CREATE TABLE IF NOT EXISTS calendar_cache (
  weekday_id INTEGER NOT NULL,        -- 1=Mon .. 7=Sun
  subject_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  name_cn TEXT NOT NULL DEFAULT '',
  air_date TEXT,
  score REAL,
  rank INTEGER,
  images_json TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (weekday_id, subject_id)
);

CREATE TABLE IF NOT EXISTS api_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_api_cache_fetched ON api_cache(fetched_at);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function migrateCollectionColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(collection)').all() as Array<{ name: string }>;
  const existing = new Set(cols.map((c) => c.name));

  if (!existing.has('subject_rank')) {
    db.exec('ALTER TABLE collection ADD COLUMN subject_rank INTEGER;');
  }
  if (!existing.has('subject_total')) {
    db.exec('ALTER TABLE collection ADD COLUMN subject_total INTEGER NOT NULL DEFAULT 0;');
  }
  if (!existing.has('subject_platform')) {
    db.exec("ALTER TABLE collection ADD COLUMN subject_platform TEXT NOT NULL DEFAULT '';");
  }
  if (!existing.has('subject_tags_json')) {
    db.exec("ALTER TABLE collection ADD COLUMN subject_tags_json TEXT NOT NULL DEFAULT '[]';");
  }
}

export function openCollectionDb(userDbPath?: string): Database.Database {
  const resolvedPath = userDbPath ?? getAppPaths().userDbPath;
  if (resolvedPath !== ':memory:') {
    ensureDir(dirname(resolvedPath));
  }
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.exec(COLLECTION_SCHEMA_SQL);
  migrateCollectionColumns(db);
  return db;
}

export interface CachedEntry<T> {
  value: T;
  fetchedAt: number;
  stale: boolean;
}

export function readApiCache<T>(
  db: Database.Database,
  cacheKey: string,
  allowStale = false
): CachedEntry<T> | null {
  const row = db
    .prepare(
      'SELECT payload_json, fetched_at, expires_at FROM api_cache WHERE cache_key = ?'
    )
    .get(cacheKey) as
    | { payload_json: string; fetched_at: number; expires_at: number }
    | undefined;

  if (!row) return null;
  const now = Date.now();
  const isStale = now > row.expires_at;
  if (isStale && !allowStale) return null;

  try {
    return {
      value: JSON.parse(row.payload_json) as T,
      fetchedAt: row.fetched_at,
      stale: isStale
    };
  } catch {
    return null;
  }
}

export function writeApiCache<T>(
  db: Database.Database,
  cacheKey: string,
  payload: T,
  ttlMs: number,
  maxRows = MAX_API_CACHE_ROWS
): void {
  const now = Date.now();
  const expiresAt = now + Math.max(1000, ttlMs);

  db.prepare(
    `INSERT OR REPLACE INTO api_cache (cache_key, payload_json, fetched_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(cacheKey, JSON.stringify(payload), now, expiresAt);

  // Bounded LRU pruning so collection.db never grows beyond a few MBs
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM api_cache').get() as { cnt: number };
  if (countRow.cnt > maxRows) {
    db.prepare('DELETE FROM api_cache WHERE expires_at < ?').run(now);
    const afterRow = db.prepare('SELECT COUNT(*) AS cnt FROM api_cache').get() as { cnt: number };
    if (afterRow.cnt > maxRows) {
      const excess = afterRow.cnt - maxRows;
      db.prepare(
        `DELETE FROM api_cache WHERE cache_key IN (
           SELECT cache_key FROM api_cache ORDER BY fetched_at ASC LIMIT ?
         )`
      ).run(excess);
    }
  }
}

export function clearApiCache(db: Database.Database): number {
  const info = db.prepare('DELETE FROM api_cache').run();
  db.exec('VACUUM;');
  return info.changes;
}
