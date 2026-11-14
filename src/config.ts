import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_AGENT = 'tianchu/mokuroku';
export const BGM_API_BASE_URL = 'https://api.bgm.tv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function discoverProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const pkgPath = resolve(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'mokuroku') {
          return dir;
        }
      } catch {
        // continue walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = discoverProjectRoot(__dirname);

let envLoaded = false;

export function loadDotEnv(envPath = resolve(PROJECT_ROOT, '.env')): void {
  if (envLoaded) return;
  envLoaded = true;
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export interface AppPaths {
  rootDir: string;
  dataDir: string;
  cacheDir: string;
  coversDir: string;
  userDbPath: string;
}

export function getAppPaths(overrides?: { dataDir?: string; cacheDir?: string }): AppPaths {
  loadDotEnv();
  const dataDir = resolve(
    PROJECT_ROOT,
    overrides?.dataDir ?? process.env.MOKUROKU_DATA_DIR ?? 'data'
  );
  const cacheDir = resolve(
    PROJECT_ROOT,
    overrides?.cacheDir ?? process.env.MOKUROKU_CACHE_DIR ?? 'cache'
  );
  const coversDir = resolve(cacheDir, 'covers');
  const userDbPath = resolve(dataDir, 'collection.db');

  return {
    rootDir: PROJECT_ROOT,
    dataDir,
    cacheDir,
    coversDir,
    userDbPath
  };
}

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}
