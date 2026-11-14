import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { BangumiClient } from '../../../api/client.js';
import { getAppPaths } from '../../../config.js';
import {
  openArchiveDb,
  openCollectionDb,
  readActivePointer,
  resolveActiveArchiveDbPath
} from '../../../db/open.js';

let cachedArchiveDb: Database.Database | null = null;
let cachedArchiveDbPath = '';
let cachedArchiveUpdatedAt = '';

let cachedCollectionDb: Database.Database | null = null;
let cachedClient: BangumiClient | null = null;

/**
 * 获取当前激活的只读 Archive SQLite 连接。
 * 当 mokuroku sync 完成双库原子切换更新 active-db.json 后，下次请求自动热切换连接。
 */
export function getServerArchiveDb(): Database.Database | null {
  const paths = getAppPaths();
  const pointer = readActivePointer(paths.dataDir);
  const targetPath = resolveActiveArchiveDbPath(paths.dataDir);

  if (!existsSync(targetPath)) {
    return null;
  }

  const pointerStamp = `${targetPath}|${pointer?.updatedAt ?? ''}`;
  if (cachedArchiveDb && `${cachedArchiveDbPath}|${cachedArchiveUpdatedAt}` === pointerStamp) {
    return cachedArchiveDb;
  }

  if (cachedArchiveDb) {
    try {
      cachedArchiveDb.close();
    } catch {
      // ignore close error on old slot
    }
    cachedArchiveDb = null;
  }

  cachedArchiveDb = openArchiveDb(targetPath, { readonly: true, fileMustExist: true });
  cachedArchiveDbPath = targetPath;
  cachedArchiveUpdatedAt = pointer?.updatedAt ?? '';
  return cachedArchiveDb;
}

export function getServerCollectionDb(): Database.Database {
  if (!cachedCollectionDb) {
    cachedCollectionDb = openCollectionDb();
  }
  return cachedCollectionDb;
}

export function getServerBangumiClient(): BangumiClient {
  if (!cachedClient) {
    cachedClient = new BangumiClient();
  }
  return cachedClient;
}
