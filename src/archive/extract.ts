import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { ensureDir } from '../config.js';

export type ArchiveTableName =
  | 'subject'
  | 'episode'
  | 'character'
  | 'person'
  | 'subject_relations'
  | 'subject_characters'
  | 'subject_persons'
  | 'person_characters'
  | 'person_relations';

export const ARCHIVE_TABLE_STEMS: Record<ArchiveTableName, readonly string[]> = {
  subject: ['subject'],
  episode: ['episode'],
  character: ['character'],
  person: ['person'],
  subject_relations: ['subject-relations', 'subject_relations'],
  subject_characters: ['subject-characters', 'subject_characters'],
  subject_persons: ['subject-persons', 'subject_persons'],
  person_characters: ['person-characters', 'person_characters'],
  person_relations: ['person-relations', 'person_relations']
};

export const ARCHIVE_EXTENSIONS = ['.jsonlines', '.jsonl', '.json'] as const;

export class ZipSlipError extends Error {
  readonly entryName: string;

  constructor(entryName: string) {
    super(`拒绝不安全的压缩包路径 (Zip Slip 防护): ${entryName}`);
    this.name = 'ZipSlipError';
    this.entryName = entryName;
  }
}

/**
 * 规范化并校验压缩包成员路径，拒绝 `..` 越界、绝对路径、盘符路径及空字节。
 */
export function resolveSafeExtractPath(destDir: string, entryFileName: string): string {
  if (!entryFileName || entryFileName.includes('\0')) {
    throw new ZipSlipError(entryFileName);
  }

  // Reject Windows drive prefix (e.g. C:\ or C:foo) and leading slashes (/ or \)
  if (/^[a-zA-Z]:/.test(entryFileName) || /^[\\/]/.test(entryFileName)) {
    throw new ZipSlipError(entryFileName);
  }

  const normalizedSlashes = entryFileName.replace(/\\/g, '/');
  const segments = normalizedSlashes.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new ZipSlipError(entryFileName);
    }
  }

  const rootResolved = resolve(destDir);
  const targetResolved = resolve(rootResolved, normalizedSlashes);
  const rel = relative(rootResolved, targetResolved);

  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ZipSlipError(entryFileName);
  }

  return targetResolved;
}

export interface ExtractArchiveOptions {
  zipPath: string;
  destDir: string;
  onEntry?: (entryName: string, uncompressedSize: number) => void;
}

export interface ExtractArchiveResult {
  destDir: string;
  extractedFiles: string[];
  tables: Partial<Record<ArchiveTableName, string>>;
}

export async function extractArchiveZip(
  options: ExtractArchiveOptions
): Promise<ExtractArchiveResult> {
  ensureDir(options.destDir);
  const extractedFiles: string[] = [];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    yauzl.open(options.zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        rejectPromise(openErr ?? new Error(`无法打开压缩包: ${options.zipPath}`));
        return;
      }

      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          // ignore close error
        }
        if (err instanceof ZipSlipError) {
          rejectPromise(err);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (/invalid relative path|absolute path/i.test(msg)) {
          rejectPromise(new ZipSlipError(msg));
          return;
        }
        rejectPromise(err instanceof Error ? err : new Error(msg));
      };

      zipfile.on('error', fail);

      zipfile.on('entry', (entry: yauzl.Entry) => {
        let targetPath: string;
        try {
          targetPath = resolveSafeExtractPath(options.destDir, entry.fileName);
        } catch (err) {
          fail(err);
          return;
        }

        // Directory entry
        if (/[/\\]$/.test(entry.fileName)) {
          try {
            ensureDir(targetPath);
            zipfile.readEntry();
          } catch (err) {
            fail(err);
          }
          return;
        }

        options.onEntry?.(entry.fileName, entry.uncompressedSize);
        ensureDir(dirname(targetPath));

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(streamErr ?? new Error(`无法读取压缩包成员: ${entry.fileName}`));
            return;
          }

          const outStream = createWriteStream(targetPath, { flags: 'w' });
          pipeline(readStream, outStream)
            .then(() => {
              if (settled) return;
              extractedFiles.push(targetPath);
              zipfile.readEntry();
            })
            .catch(fail);
        });
      });

      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      });

      zipfile.readEntry();
    });
  });

  const tables = detectArchiveTableFiles(options.destDir);
  return {
    destDir: options.destDir,
    extractedFiles,
    tables
  };
}

/**
 * 按优先级探测解压目录中的各表文件：
 * 扩展名优先级: .jsonlines -> .jsonl -> .json
 * 词干变体: 连字符 (subject-relations) 与 下划线 (subject_relations) 均探测
 */
export function detectArchiveTableFiles(
  extractDir: string
): Partial<Record<ArchiveTableName, string>> {
  const searchDirs: string[] = [resolve(extractDir)];
  if (existsSync(extractDir)) {
    for (const entry of readdirSync(extractDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        searchDirs.push(resolve(extractDir, entry.name));
      }
    }
  }

  // Build case-insensitive file map per directory for cross-platform safety
  const dirMaps = searchDirs.map((dir) => {
    const map = new Map<string, string>();
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        if (statSync(full).isFile()) {
          map.set(name.toLowerCase(), full);
        }
      }
    }
    return map;
  });

  const resolved: Partial<Record<ArchiveTableName, string>> = {};

  for (const table of Object.keys(ARCHIVE_TABLE_STEMS) as ArchiveTableName[]) {
    const stems = ARCHIVE_TABLE_STEMS[table];
    let found: string | undefined;

    outer: for (const ext of ARCHIVE_EXTENSIONS) {
      for (const stem of stems) {
        const candidateName = `${stem}${ext}`.toLowerCase();
        for (const map of dirMaps) {
          const hit = map.get(candidateName);
          if (hit) {
            found = hit;
            break outer;
          }
        }
      }
    }

    if (found) {
      resolved[table] = found;
    }
  }

  return resolved;
}
