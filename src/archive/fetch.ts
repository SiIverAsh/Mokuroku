import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  DEFAULT_LATEST_JSON_URL,
  FALLBACK_LATEST_JSON_API_URL,
  USER_AGENT,
  ensureDir
} from '../config.js';

export interface ArchiveLatestMeta {
  name: string;
  browser_download_url: string;
  url?: string;
  size: number;
  digest: string;
  sha256: string;
  updated_at: string;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  resumedFromBytes: number;
}

export interface FetchArchiveOptions {
  latestJsonUrl?: string;
  destDir: string;
  allowApiFallback?: boolean;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface FetchArchiveResult {
  zipPath: string;
  meta: ArchiveLatestMeta;
  sha256: string;
  resumed: boolean;
  skippedDownload: boolean;
}

export class Sha256MismatchError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`SHA-256 校验失败: 期望 ${expected}，实际 ${actual}`);
    this.name = 'Sha256MismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export function parseSha256Digest(digest: string): string {
  const normalized = digest.trim().replace(/^sha256:/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`无效的 SHA-256 digest 格式: ${digest}`);
  }
  return normalized;
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex').toLowerCase();
}

export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<string> {
  const expected = parseSha256Digest(expectedSha256);
  const actual = await computeFileSha256(filePath);
  if (actual !== expected) {
    throw new Sha256MismatchError(expected, actual);
  }
  return actual;
}

export async function fetchLatestMeta(options?: {
  latestJsonUrl?: string;
  allowApiFallback?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<ArchiveLatestMeta> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const primaryUrl = options?.latestJsonUrl ?? DEFAULT_LATEST_JSON_URL;
  const allowFallback =
    options?.allowApiFallback ?? primaryUrl === DEFAULT_LATEST_JSON_URL;

  let raw: Record<string, unknown> | null = null;
  try {
    const res = await fetchFn(primaryUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      }
    });
    if (!res.ok) {
      throw new Error(`获取 latest.json 失败 (${res.status} ${res.statusText})`);
    }
    raw = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (!allowFallback) {
      throw err;
    }
    const fallbackRes = await fetchFn(FALLBACK_LATEST_JSON_API_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github.raw+json'
      }
    });
    if (!fallbackRes.ok) {
      throw new Error(
        `获取 latest.json 失败: 主源错误 ${(err as Error).message}; 备源状态 ${fallbackRes.status}`
      );
    }
    raw = (await fallbackRes.json()) as Record<string, unknown>;
  }

  const browserDownloadUrl = String(raw.browser_download_url ?? '');
  if (!browserDownloadUrl) {
    throw new Error('latest.json 缺少 browser_download_url');
  }
  const digest = String(raw.digest ?? '');
  const sha256 = parseSha256Digest(digest);
  const size = Number(raw.size ?? 0);
  const updatedAt = String(raw.updated_at ?? '');
  const inferredName =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : basename(new URL(browserDownloadUrl).pathname);

  return {
    name: inferredName || 'bangumi-dump.zip',
    browser_download_url: browserDownloadUrl,
    url: typeof raw.url === 'string' && raw.url ? raw.url : undefined,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    digest,
    sha256,
    updated_at: updatedAt
  };
}

interface PartCheckpoint {
  sha256: string;
  size: number;
  updated_at: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function downloadArchive(options: FetchArchiveOptions): Promise<FetchArchiveResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 4;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  const allowFallback =
    options.allowApiFallback ??
    (!options.latestJsonUrl || options.latestJsonUrl === DEFAULT_LATEST_JSON_URL);

  ensureDir(options.destDir);

  const meta = await fetchLatestMeta({
    latestJsonUrl: options.latestJsonUrl,
    allowApiFallback: allowFallback,
    fetchImpl: fetchFn
  });

  const safeFileName = basename(meta.name);
  const zipPath = resolve(options.destDir, safeFileName);
  const partPath = `${zipPath}.part`;
  const partMetaPath = `${zipPath}.part.json`;

  if (existsSync(zipPath)) {
    const stat = statSync(zipPath);
    if (meta.size === 0 || stat.size === meta.size) {
      try {
        const sha256 = await verifyFileSha256(zipPath, meta.sha256);
        return {
          zipPath,
          meta,
          sha256,
          resumed: false,
          skippedDownload: true
        };
      } catch {
        rmSync(zipPath, { force: true });
      }
    } else {
      rmSync(zipPath, { force: true });
    }
  }

  // Validate existing .part checkpoint matches current dump digest
  if (existsSync(partPath) && existsSync(partMetaPath)) {
    try {
      const saved = JSON.parse(readFileSync(partMetaPath, 'utf8')) as PartCheckpoint;
      if (saved.sha256 !== meta.sha256) {
        rmSync(partPath, { force: true });
        rmSync(partMetaPath, { force: true });
      }
    } catch {
      rmSync(partPath, { force: true });
      rmSync(partMetaPath, { force: true });
    }
  }

  const candidateUrls: Array<{ url: string; accept?: string }> = [
    { url: meta.browser_download_url }
  ];
  if (allowFallback && meta.url) {
    candidateUrls.push({ url: meta.url, accept: 'application/octet-stream' });
  }

  let urlIndex = 0;
  let everResumed = false;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let existingBytes = existsSync(partPath) ? statSync(partPath).size : 0;
    if (meta.size > 0 && existingBytes > meta.size) {
      rmSync(partPath, { force: true });
      existingBytes = 0;
    }
    if (meta.size > 0 && existingBytes === meta.size) {
      break;
    }

    const currentCandidate = candidateUrls[Math.min(urlIndex, candidateUrls.length - 1)];
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT
    };
    if (currentCandidate.accept) {
      headers.Accept = currentCandidate.accept;
    }
    if (existingBytes > 0) {
      headers.Range = `bytes=${existingBytes}-`;
    }

    try {
      const res = await fetchFn(currentCandidate.url, { headers });

      if (res.status === 416) {
        rmSync(partPath, { force: true });
        continue;
      }

      if (!res.ok && res.status !== 206) {
        throw new Error(`下载归档失败: HTTP ${res.status} ${res.statusText}`);
      }

      const isPartial = res.status === 206 && existingBytes > 0;
      if (isPartial) {
        everResumed = true;
      } else {
        existingBytes = 0;
      }

      ensureDir(dirname(partPath));
      const checkpoint: PartCheckpoint = {
        sha256: meta.sha256,
        size: meta.size,
        updated_at: meta.updated_at
      };
      writeFileSync(partMetaPath, JSON.stringify(checkpoint), 'utf8');

      if (!res.body) {
        throw new Error('下载响应无可读流 body');
      }

      const contentLengthHeader = Number(res.headers.get('content-length') ?? 0);
      const totalBytes =
        meta.size > 0
          ? meta.size
          : contentLengthHeader > 0
            ? existingBytes + contentLengthHeader
            : 0;

      const nodeReadable = Readable.fromWeb(res.body as unknown as WebReadableStream);
      const fileOut = createWriteStream(partPath, {
        flags: isPartial ? 'a' : 'w'
      });

      let downloadedBytes = existingBytes;
      const startedAt = Date.now();
      let lastReportAt = 0;

      nodeReadable.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (options.onProgress) {
          const now = Date.now();
          if (now - lastReportAt >= 250 || (totalBytes > 0 && downloadedBytes >= totalBytes)) {
            lastReportAt = now;
            const elapsedSec = Math.max((now - startedAt) / 1000, 0.001);
            const sessionBytes = downloadedBytes - existingBytes;
            const speedBps = sessionBytes / elapsedSec;
            const remaining = totalBytes > downloadedBytes ? totalBytes - downloadedBytes : 0;
            const etaSeconds =
              totalBytes > 0 && speedBps > 0 ? Math.ceil(remaining / speedBps) : null;
            options.onProgress({
              downloadedBytes,
              totalBytes,
              speedBps,
              etaSeconds,
              resumedFromBytes: existingBytes
            });
          }
        }
      });

      await pipeline(nodeReadable, fileOut);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (urlIndex + 1 < candidateUrls.length) {
        urlIndex += 1;
        // Immediate switch to fallback asset URL without wasting retry delay
        attempt -= 1;
        continue;
      }
      if (attempt < maxRetries) {
        await sleep(retryBaseDelayMs * Math.pow(2, attempt));
      }
    }
  }

  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  if (!existsSync(partPath)) {
    throw new Error(`下载未生成临时文件: ${partPath}`);
  }

  let verifiedSha256: string;
  try {
    verifiedSha256 = await verifyFileSha256(partPath, meta.sha256);
  } catch (err) {
    rmSync(partPath, { force: true });
    rmSync(partMetaPath, { force: true });
    throw err;
  }

  rmSync(zipPath, { force: true });
  renameSync(partPath, zipPath);
  rmSync(partMetaPath, { force: true });

  return {
    zipPath,
    meta,
    sha256: verifiedSha256,
    resumed: everResumed,
    skippedDownload: false
  };
}
