#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cac } from 'cac';
import { BangumiClient } from './api/client.js';
import { syncArchivePipeline } from './archive/sync.js';
import { PROJECT_ROOT, getAppPaths, loadDotEnv } from './config.js';
import {
  openArchiveDb,
  openCollectionDb,
  readActivePointer,
  resolveActiveArchiveDbPath
} from './db/open.js';
import { searchSubjects } from './search.js';

loadDotEnv();

const cli = cac('mokuroku');

cli
  .command('sync', '下载最新 Bangumi Archive 快照 → SHA256 校验 → 流式解压 → 导入 SQLite → 双库原子切换')
  .option('--skip-if-unchanged', '若远端 SHA256 与当前激活库一致则跳过重复导入')
  .option('--keep-temp', '保留下载的 zip 与临时解压目录（默认导入成功后自动删除）')
  .action(async (opts: { skipIfUnchanged?: boolean; keepTemp?: boolean }) => {
    console.log('[mokuroku] 开始同步 Bangumi Archive 全量快照...');
    let lastLoggedPct = -5;

    const res = await syncArchivePipeline({
      skipIfUnchanged: Boolean(opts.skipIfUnchanged),
      keepTempFiles: Boolean(opts.keepTemp),
      onDownloadProgress: (p) => {
        if (p.totalBytes > 0) {
          const pct = Math.floor((p.downloadedBytes / p.totalBytes) * 100);
          if (pct >= lastLoggedPct + 10 || p.downloadedBytes === p.totalBytes) {
            lastLoggedPct = pct;
            const dlMb = (p.downloadedBytes / 1024 / 1024).toFixed(1);
            const totalMb = (p.totalBytes / 1024 / 1024).toFixed(1);
            const speedMb = (p.speedBps / 1024 / 1024).toFixed(2);
            console.log(
              `  [下载] ${pct}% (${dlMb}/${totalMb} MB) | ${speedMb} MB/s | ETA ${p.etaSeconds ?? 0}s`
            );
          }
        }
      },
      onExtractEntry: (name, size) => {
        console.log(`  [解压] ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      },
      onImportProgress: (table, count) => {
        if (count === 0) {
          console.log(`  [构建] ${table}...`);
        } else if (count % 250_000 === 0) {
          console.log(`  [导入:${table}] ${count.toLocaleString()} 行`);
        }
      }
    });

    if (res.skippedUnchanged) {
      const ptr = readActivePointer();
      console.log(
        `[mokuroku] 当前激活库 (${ptr?.activeFile}) 已是最新快照 (${ptr?.dumpName ?? ptr?.sha256?.slice(0, 12)})，无需重复导入。`
      );
      return;
    }

    const imp = res.importResult!;
    console.log('\n==================== 同步完成汇总 ====================');
    console.log(`快照文件    : ${res.download?.meta.name} (${res.download?.meta.updated_at})`);
    console.log(`SHA-256     : ${res.download?.sha256}`);
    console.log(`当前激活库  : ${imp.activePointer?.activeFile ?? imp.dbPath}`);
    console.log(`临时文件清理: ${res.cleanedUp ? '已删除 zip 与解压目录' : '已保留'}`);
    console.log(`峰值内存    : ${res.peakRssMb} MB`);
    console.log(`总耗时      : ${(res.totalDurationMs / 1000).toFixed(1)} 秒`);
    console.log('-------------------- 各表导入行数 --------------------');
    for (const [table, count] of Object.entries(imp.rowCounts)) {
      console.log(`  ${table.padEnd(20)} : ${count.toLocaleString()}`);
    }
    console.log('-------------------- Infobox 解析 --------------------');
    console.log(`  解析总数             : ${imp.infoboxStats.total.toLocaleString()}`);
    console.log(`  解析成功             : ${imp.infoboxStats.succeeded.toLocaleString()}`);
    console.log(`  语法错误跳过数       : ${imp.infoboxStats.failed.toLocaleString()}`);
    if (imp.jsonLineErrors > 0) {
      console.log(`  JSONL 损坏行跳过数   : ${imp.jsonLineErrors.toLocaleString()}`);
    }
    console.log('======================================================');
  });

cli
  .command('search <...keyword>', '使用 sqlite-better-trigram FTS5 检索本地条目库')
  .option('-t, --type <type>', '按作品类型筛选 (1=漫画/书籍 2=动画 3=音乐 4=游戏 6=三次元)')
  .option('-p, --platform <platform>', '按平台代码筛选')
  .option('-l, --limit <limit>', '返回条数上限', { default: 15 })
  .option('--nsfw', '包含 NSFW 条目')
  .option('--json', '以 JSON 格式输出')
  .action(
    (
      keywordParts: string[],
      opts: {
        type?: string;
        platform?: string;
        limit?: number;
        nsfw?: boolean;
        json?: boolean;
      }
    ) => {
      const kw = keywordParts.join(' ').trim();
      const dbPath = resolveActiveArchiveDbPath();
      if (!existsSync(dbPath)) {
        console.error(`[mokuroku] 未找到本地离线库 (${dbPath})，请先执行: pnpm mokuroku sync`);
        process.exitCode = 1;
        return;
      }

      const t0 = performance.now();
      const db = openArchiveDb(dbPath, { readonly: true, fileMustExist: true });
      try {
        const hits = searchSubjects(db, kw, {
          type: opts.type !== undefined ? Number(opts.type) : undefined,
          platform: opts.platform !== undefined ? Number(opts.platform) : undefined,
          limit: Number(opts.limit ?? 15),
          includeNsfw: Boolean(opts.nsfw)
        });
        const elapsedMs = (performance.now() - t0).toFixed(2);

        if (opts.json) {
          console.log(JSON.stringify({ query: kw, elapsedMs: Number(elapsedMs), hits }, null, 2));
          return;
        }

        console.log(`检索词: "${kw}" | 命中 ${hits.length} 条 | 耗时 ${elapsedMs} ms\n`);
        if (hits.length === 0) {
          console.log('（无匹配结果）');
          return;
        }

        for (const h of hits) {
          const scoreStr = h.score !== null ? `★${h.score.toFixed(1)}` : '★ - ';
          const rankStr = h.rank !== null ? `#${h.rank}` : '#-';
          const tagLabel = [h.typeLabel, h.platformLabel].filter(Boolean).join('/');
          const titleDisplay =
            h.nameCn && h.nameCn !== h.name ? `${h.nameCn} (${h.name})` : h.name;
          const aliasPreview =
            h.aliases.length > 0 ? ` | 别名: ${h.aliases.slice(0, 3).join(', ')}` : '';
          console.log(
            `[${String(h.id).padStart(6)}] [${tagLabel}] ${scoreStr} (${rankStr}, 藏:${h.favTotal}) ${titleDisplay}${aliasPreview}`
          );
        }
      } finally {
        db.close();
      }
    }
  );

cli
  .command('pull-collection', '从 Bangumi v0 API 拉取个人收藏与在看章节进度至独立 collection.db')
  .option('--all-types', '拉取全部条目类型（默认仅拉取动画 subject_type=2）')
  .option('--calendar', '同时同步每周放送日历 (/calendar)')
  .action(async (opts: { allTypes?: boolean; calendar?: boolean }) => {
    const { userDbPath } = getAppPaths();
    const collectionDb = openCollectionDb(userDbPath);
    const client = new BangumiClient();

    try {
      const subjectTypes = opts.allTypes ? [1, 2, 3, 4, 6] : [2];
      console.log(`[mokuroku] 正在串行拉取个人收藏 (types=${subjectTypes.join(',')})...`);
      const res = await client.pullAllCollectionsToDb(collectionDb, {
        subjectTypes,
        includeWatchingEpisodes: true,
        onProgress: (pulled, total, st) => {
          console.log(`  [type=${st}] 已落盘 ${pulled}/${total}`);
        }
      });
      console.log(
        `[mokuroku] 收藏同步完成：共保存 ${res.totalSaved} 条收藏，同步 ${res.episodesSyncedSubjects} 部在看章节进度。`
      );

      if (opts.calendar) {
        const days = await client.syncCalendarToDb(collectionDb);
        const totalItems = days.reduce((acc, d) => acc + (d.items?.length ?? 0), 0);
        console.log(`[mokuroku] 放送日历同步完成：${days.length} 天共 ${totalItems} 部番剧。`);
      }
    } catch (err) {
      console.error(`[mokuroku] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      collectionDb.close();
    }
  });

cli
  .command('serve', '启动本地 SvelteKit 看板服务（仅绑定 127.0.0.1）')
  .option('-p, --port <port>', '监听端口', { default: process.env.MOKUROKU_PORT ?? '4173' })
  .option('-H, --host <host>', '监听地址', { default: process.env.MOKUROKU_HOST ?? '127.0.0.1' })
  .option('--dev', '以开发模式启动 Vite')
  .action((opts: { port?: string; host?: string; dev?: boolean }) => {
    const host = String(opts.host ?? '127.0.0.1');
    const port = String(opts.port ?? '4173');
    const viteBin = resolve(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const builtServer = resolve(PROJECT_ROOT, 'build', 'index.js');

    if (opts.dev) {
      const child = spawn(process.execPath, [viteBin, 'dev', '--host', host, '--port', port], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit'
      });
      child.on('exit', (c) => process.exit(c ?? 0));
      return;
    }

    if (!existsSync(builtServer)) {
      console.log('[mokuroku] 首次启动，正在构建生产版 SvelteKit 看板...');
      execFileSync(process.execPath, [viteBin, 'build'], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit'
      });
    }

    console.log(`[mokuroku] 看板已启动: http://${host}:${port}`);
    const child = spawn(process.execPath, ['--use-env-proxy', builtServer], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        HOST: host,
        PORT: port,
        ORIGIN: `http://${host}:${port}`,
        NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost'
      }
    });
    child.on('exit', (c) => process.exit(c ?? 0));
  });

cli
  .command('schedule', '管理每周四自动同步 Bangumi Archive 的 Windows 计划任务')
  .option('--install', '注册每周四定时同步计划任务 (MokurokuWeeklySync)')
  .option('--remove', '移除计划任务')
  .option('--status', '查询计划任务状态')
  .option('--time <hhmm>', '每周四执行时间 (24小时制)', { default: '06:00' })
  .action(
    (opts: { install?: boolean; remove?: boolean; status?: boolean; time?: string }) => {
      const taskName = 'MokurokuWeeklySync';
      const scriptPath = resolve(PROJECT_ROOT, 'scripts', 'sync-weekly.cmd');
      const timeStr = opts.time ?? '06:00';

      if (opts.remove) {
        execFileSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { stdio: 'inherit' });
        return;
      }

      if (opts.install) {
        execFileSync(
          'schtasks.exe',
          [
            '/Create',
            '/TN',
            taskName,
            '/TR',
            `"${scriptPath}"`,
            '/SC',
            'WEEKLY',
            '/D',
            'THU',
            '/ST',
            timeStr,
            '/F'
          ],
          { stdio: 'inherit' }
        );
        console.log(`[mokuroku] 已注册每周四 ${timeStr} 自动同步任务: ${taskName}`);
        return;
      }

      try {
        execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/V', '/FO', 'LIST'], {
          stdio: 'inherit'
        });
      } catch {
        console.log(
          `[mokuroku] 尚未注册计划任务 ${taskName}。可执行: pnpm mokuroku schedule --install`
        );
      }
    }
  );

cli.help();
cli.version('0.1.0');

cli.parse();
