import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureDir, getAppPaths } from '../config.js';
import { readActivePointer } from '../db/open.js';
import { extractArchiveZip } from './extract.js';
import {
  type DownloadProgress,
  type FetchArchiveResult,
  downloadArchive,
  fetchLatestMeta
} from './fetch.js';
import { type ImportArchiveResult, importArchiveToSqlite } from './importer.js';

export interface SyncArchiveOptions {
  dataDir?: string;
  cacheDir?: string;
  latestJsonUrl?: string;
  skipIfUnchanged?: boolean;
  keepTempFiles?: boolean;
  fetchImpl?: typeof fetch;
  onDownloadProgress?: (p: DownloadProgress) => void;
  onExtractEntry?: (entryName: string, uncompressedSize: number) => void;
  onImportProgress?: (table: string, count: number) => void;
}

export interface SyncArchiveResult {
  skippedUnchanged: boolean;
  download: FetchArchiveResult | null;
  importResult: ImportArchiveResult | null;
  cleanedUp: boolean;
  peakRssMb: number;
  totalDurationMs: number;
}

export async function syncArchivePipeline(
  options?: SyncArchiveOptions
): Promise<SyncArchiveResult> {
  const t0 = Date.now();
  let peakRss = process.memoryUsage().rss;
  const trackMemory = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };

  const paths = getAppPaths({
    dataDir: options?.dataDir,
    cacheDir: options?.cacheDir
  });
  ensureDir(paths.dataDir);
  ensureDir(paths.downloadsDir);

  if (options?.skipIfUnchanged) {
    const currentPointer = readActivePointer(paths.dataDir);
    if (currentPointer?.sha256) {
      const activeDbFile = resolve(paths.dataDir, currentPointer.activeFile);
      if (existsSync(activeDbFile)) {
        const remoteMeta = await fetchLatestMeta({
          latestJsonUrl: options.latestJsonUrl,
          fetchImpl: options.fetchImpl
        });
        if (remoteMeta.sha256 === currentPointer.sha256) {
          return {
            skippedUnchanged: true,
            download: null,
            importResult: null,
            cleanedUp: true,
            peakRssMb: Number((peakRss / 1024 / 1024).toFixed(1)),
            totalDurationMs: Date.now() - t0
          };
        }
      }
    }
  }

  const extractDir = resolve(paths.cacheDir, `extract-${Date.now()}-${process.pid}`);
  let zipPathToClean: string | null = null;
  let cleanedUp = false;

  try {
    const dl = await downloadArchive({
      latestJsonUrl: options?.latestJsonUrl,
      destDir: paths.downloadsDir,
      fetchImpl: options?.fetchImpl,
      onProgress: (p) => {
        trackMemory();
        options?.onDownloadProgress?.(p);
      }
    });
    zipPathToClean = dl.zipPath;
    trackMemory();

    const extracted = await extractArchiveZip({
      zipPath: dl.zipPath,
      destDir: extractDir,
      onEntry: (name, size) => {
        trackMemory();
        options?.onExtractEntry?.(name, size);
      }
    });
    trackMemory();

    const importRes = await importArchiveToSqlite({
      extractDir: extracted.destDir,
      tables: extracted.tables,
      dataDir: paths.dataDir,
      parseInfobox: true,
      switchActive: true,
      dumpMeta: {
        name: dl.meta.name,
        updatedAt: dl.meta.updated_at,
        sha256: dl.sha256
      },
      onProgress: (table, count) => {
        trackMemory();
        options?.onImportProgress?.(table, count);
      }
    });
    trackMemory();

    if (!options?.keepTempFiles) {
      if (existsSync(extractDir)) {
        rmSync(extractDir, { recursive: true, force: true });
      }
      if (zipPathToClean && existsSync(zipPathToClean)) {
        rmSync(zipPathToClean, { force: true });
      }
      cleanedUp = true;
    }

    return {
      skippedUnchanged: false,
      download: dl,
      importResult: importRes,
      cleanedUp,
      peakRssMb: Number((peakRss / 1024 / 1024).toFixed(1)),
      totalDurationMs: Date.now() - t0
    };
  } catch (err) {
    // Clean up extracted temp directory on error, but keep .part checkpoint if download failed mid-way
    if (!options?.keepTempFiles && existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
    throw err;
  }
}
