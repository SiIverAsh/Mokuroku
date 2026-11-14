import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-better-trigram';
import { PROJECT_ROOT, ensureDir, getAppPaths } from '../config.js';

export const SCHEMA_SQL_PATH = resolve(PROJECT_ROOT, 'src', 'db', 'schema.sql');

export const SLOT_A_FILENAME = 'mokuroku-a.db';
export const SLOT_B_FILENAME = 'mokuroku-b.db';

export interface ActiveDbPointer {
  activeFile: string;
  updatedAt: string;
  dumpName?: string;
  dumpUpdatedAt?: string;
  sha256?: string;
  rowCounts?: Record<string, number>;
  infoboxFailures?: number;
}

export function resolveBetterTrigramPath(): string {
  try {
    const p = getLoadablePath();
    if (p && existsSync(p)) {
      return p;
    }
  } catch {
    // Fallback to explicit Windows binary location
  }
  const winFallback = resolve(
    PROJECT_ROOT,
    'node_modules',
    'sqlite-better-trigram-windows-x64',
    'better-trigram.dll'
  );
  if (existsSync(winFallback)) {
    return winFallback;
  }
  return getLoadablePath();
}

export function loadBetterTrigram(db: Database.Database): void {
  db.loadExtension(resolveBetterTrigramPath());
}

export interface OpenArchiveDbOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  importMode?: boolean;
}

export function openArchiveDb(
  dbPath: string,
  options?: OpenArchiveDbOptions
): Database.Database {
  if (!options?.readonly && dbPath !== ':memory:') {
    ensureDir(dirname(dbPath));
  }

  const db = new Database(dbPath, {
    readonly: options?.readonly ?? false,
    fileMustExist: options?.fileMustExist ?? false
  });

  loadBetterTrigram(db);

  if (options?.importMode) {
    db.pragma('synchronous = OFF');
    db.pragma('journal_mode = MEMORY');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -131072'); // 128 MB
    db.pragma('locking_mode = EXCLUSIVE');
  } else if (options?.readonly) {
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -65536'); // 64 MB
    db.pragma('mmap_size = 268435456'); // 256 MB
  } else {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -65536');
    db.pragma('mmap_size = 268435456');
  }

  return db;
}

export function restorePragmasAfterImport(db: Database.Database): void {
  db.pragma('locking_mode = NORMAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('optimize');
}

export function initArchiveSchema(db: Database.Database): void {
  const sql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
  db.exec(sql);
}

export function readActivePointer(dataDir?: string): ActiveDbPointer | null {
  const { activePointerPath } = getAppPaths(dataDir ? { dataDir } : undefined);
  if (!existsSync(activePointerPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(activePointerPath, 'utf8')) as ActiveDbPointer;
  } catch {
    return null;
  }
}

export function resolveActiveArchiveDbPath(dataDir?: string): string {
  const paths = getAppPaths(dataDir ? { dataDir } : undefined);
  const pointer = readActivePointer(paths.dataDir);
  if (pointer?.activeFile) {
    const candidate = resolve(paths.dataDir, pointer.activeFile);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const slotA = resolve(paths.dataDir, SLOT_A_FILENAME);
  const slotB = resolve(paths.dataDir, SLOT_B_FILENAME);
  if (existsSync(slotA)) return slotA;
  if (existsSync(slotB)) return slotB;
  return slotA;
}

export function resolveStandbyArchiveDbPath(dataDir?: string): {
  standbyFile: string;
  standbyPath: string;
} {
  const paths = getAppPaths(dataDir ? { dataDir } : undefined);
  const pointer = readActivePointer(paths.dataDir);
  const activeFile = pointer?.activeFile;
  const standbyFile = activeFile === SLOT_A_FILENAME ? SLOT_B_FILENAME : SLOT_A_FILENAME;
  return {
    standbyFile,
    standbyPath: resolve(paths.dataDir, standbyFile)
  };
}

export function switchActiveArchiveDb(
  pointer: ActiveDbPointer,
  dataDir?: string
): ActiveDbPointer {
  const paths = getAppPaths(dataDir ? { dataDir } : undefined);
  ensureDir(paths.dataDir);
  const targetDbPath = resolve(paths.dataDir, pointer.activeFile);
  if (!existsSync(targetDbPath)) {
    throw new Error(`目标数据库文件不存在，无法切换: ${targetDbPath}`);
  }
  const tmpPointerPath = `${paths.activePointerPath}.tmp`;
  writeFileSync(tmpPointerPath, JSON.stringify(pointer, null, 2), 'utf8');
  renameSync(tmpPointerPath, paths.activePointerPath);
  return pointer;
}

const COLLECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS collection (
  subject_id INTEGER PRIMARY KEY,
  subject_type INTEGER NOT NULL DEFAULT 2,
  type INTEGER NOT NULL,              -- 1=想看, 2=看过, 3=在看, 4=搁置, 5=抛弃
  rate INTEGER NOT NULL DEFAULT 0,    -- 0=未评分, 1..10
  ep_status INTEGER NOT NULL DEFAULT 0,
  vol_status INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
  private INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  subject_name TEXT NOT NULL DEFAULT '',
  subject_name_cn TEXT NOT NULL DEFAULT '',
  subject_eps INTEGER NOT NULL DEFAULT 0,
  subject_date TEXT,
  subject_score REAL
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

CREATE TABLE IF NOT EXISTS subject_override (
  subject_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

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
  return db;
}
