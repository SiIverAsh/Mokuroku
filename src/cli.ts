#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { cac } from 'cac';
import { BangumiClient } from './api/client.js';
import { PROJECT_ROOT, getAppPaths, loadDotEnv } from './config.js';
import { clearApiCache, openCollectionDb } from './db/open.js';
import { searchSubjectsOnline } from './search.js';

loadDotEnv();

const cli = cac('mokuroku');

cli
  .command('search <...keyword>', '通过 Bangumi v0 在线 API 检索条目（含轻量本地 TTL 缓存）')
  .option('-t, --type <type>', '按作品类型筛选 (1=书籍 2=动画 3=音乐 4=游戏 6=三次元)')
  .option('-p, --platform <platform>', '按动画平台筛选 (1=TV 2=OVA 3=剧场版 5=WEB)')
  .option('-s, --sort <sort>', '排序规则 (match|rank|score|heat)', { default: 'match' })
  .option('-l, --limit <limit>', '返回条数上限', { default: 15 })
  .option('--nsfw', '包含 NSFW 条目')
  .option('--refresh', '跳过本地缓存强制在线拉取')
  .option('--json', '以 JSON 格式输出')
  .action(
    async (
      keywordParts: string[],
      opts: {
        type?: string;
        platform?: string;
        sort?: 'match' | 'rank' | 'score' | 'heat';
        limit?: number;
        nsfw?: boolean;
        refresh?: boolean;
        json?: boolean;
      }
    ) => {
      const kw = keywordParts.join(' ').trim();
      const { userDbPath } = getAppPaths();
      const db = openCollectionDb(userDbPath);
      const client = new BangumiClient({ cacheDb: db });

      const t0 = performance.now();
      try {
        const hits = await searchSubjectsOnline(client, kw, {
          type: opts.type !== undefined ? Number(opts.type) : undefined,
          platform: opts.platform !== undefined ? Number(opts.platform) : undefined,
          sort: opts.sort ?? 'match',
          limit: Number(opts.limit ?? 15),
          includeNsfw: Boolean(opts.nsfw),
          forceRefresh: Boolean(opts.refresh)
        });
        const elapsedMs = (performance.now() - t0).toFixed(2);

        if (opts.json) {
          console.log(JSON.stringify({ query: kw, elapsedMs: Number(elapsedMs), hits }, null, 2));
          return;
        }

        console.log(`在线检索: "${kw}" | 命中 ${hits.length} 条 | 耗时 ${elapsedMs} ms\n`);
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
      } catch (err) {
        console.error(
          `[mokuroku] 在线检索失败: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exitCode = 1;
      } finally {
        db.close();
      }
    }
  );

cli
  .command('pull-collection', '从 Bangumi v0 API 串行拉取个人收藏与在看章节进度至轻量本地库')
  .option('--all-types', '拉取全部条目类型（默认仅拉取动画 subject_type=2）')
  .option('--calendar', '同时同步每周放送日历 (/calendar)')
  .action(async (opts: { allTypes?: boolean; calendar?: boolean }) => {
    const { userDbPath } = getAppPaths();
    const collectionDb = openCollectionDb(userDbPath);
    const client = new BangumiClient({ cacheDb: collectionDb });

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
    const child = spawn(
      process.execPath,
      ['--env-file-if-exists=.env', '--use-env-proxy', builtServer],
      {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          HOST: host,
          PORT: port,
          ORIGIN: `http://${host}:${port}`,
          NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost'
        }
      }
    );
    child.on('exit', (c) => process.exit(c ?? 0));
  });

cli
  .command('clear-cache', '清理在线 API 临时缓存与封面缓存（保留个人收藏记录）')
  .option('--covers', '一并清空 cache/covers 封面图片缓存')
  .action((opts: { covers?: boolean }) => {
    const { userDbPath, coversDir } = getAppPaths();
    const db = openCollectionDb(userDbPath);
    try {
      const removedRows = clearApiCache(db);
      let removedCovers = 0;
      if (opts.covers && existsSync(coversDir)) {
        for (const f of readdirSync(coversDir)) {
          rmSync(resolve(coversDir, f), { force: true });
          removedCovers += 1;
        }
      }
      const dbSizeKb = existsSync(userDbPath)
        ? (statSync(userDbPath).size / 1024).toFixed(1)
        : '0.0';
      console.log(
        `[mokuroku] 已清理 ${removedRows} 条 API 缓存${opts.covers ? `、${removedCovers} 张封面缓存` : ''}；当前本地库体积: ${dbSizeKb} KB`
      );
    } finally {
      db.close();
    }
  });

cli.help();
cli.version('0.2.0');

cli.parse();
