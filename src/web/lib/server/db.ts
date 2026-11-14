import type Database from 'better-sqlite3';
import { BangumiClient } from '../../../api/client.js';
import { openCollectionDb } from '../../../db/open.js';

let cachedCollectionDb: Database.Database | null = null;
let cachedClient: BangumiClient | null = null;

export function getServerCollectionDb(): Database.Database {
  if (!cachedCollectionDb) {
    cachedCollectionDb = openCollectionDb();
  }
  return cachedCollectionDb;
}

export function getServerBangumiClient(): BangumiClient {
  if (!cachedClient) {
    cachedClient = new BangumiClient({
      cacheDb: getServerCollectionDb()
    });
  }
  return cachedClient;
}
