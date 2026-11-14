# Mokuroku（目録）

基于 **Bangumi 官方每周全量快照 (`bangumi/Archive`)** 与 **Bangumi v0 API** 的个人单机动画检索与看板工具。

## 架构概览

| 层级 | 数据源 / 组件 | 职责范围 |
| :--- | :--- | :--- |
| **离线层（覆盖 95% 场景）** | `bangumi/Archive` 周更 ZIP → `better-sqlite3` + `sqlite-better-trigram` + `@bgm38/wiki` | 全量条目/章节/人物/角色/关联落库、中日英混排与 1～2 字短词 FTS5 全文检索、Infobox 别名与制作信息结构化展开、看板统计与推荐。零延迟、断网可用。 |
| **在线层（仅 3 类操作）** | `https://api.bgm.tv/v0`（固定 UA `tianchu/mokuroku`，串行队列 + `429` 退避） | ① 个人收藏与章节进度读写（独立存储于 `data/collection.db`，快照切库绝不清空）<br>② 放送日历同步（`/calendar`）<br>③ 单条目强制刷新（`/v0/subjects/{id}`）及封面按需本地缓存（`cache/covers/{id}.jpg`） |

## 环境要求

- **Node.js** `>= 22.0.0`（ESM-only）
- **pnpm** `>= 10`
- **操作系统**：Windows x64（预置 `sqlite-better-trigram-windows-x64` 与计划任务支持）

## 快速开始（PowerShell）

```powershell
# 1. 安装依赖
pnpm install

# 2. 配置个人令牌（可选，仅同步个人收藏时需要）
Copy-Item .env.example .env
# 前往 https://next.bgm.tv/demo/access-token 生成令牌并填入 .env 的 BGM_ACCESS_TOKEN

# 3. 下载最新 Bangumi Archive 快照 → SHA-256 校验 → 流式解压 → 导入 SQLite → 双库原子切换
pnpm mokuroku sync

# 4. 本地全文检索测试（中日文原名 / 别名 / 短词）
pnpm mokuroku search 葬送的芙莉莲
pnpm mokuroku search EVA
pnpm mokuroku search 進撃

# 5. 拉取个人收藏与在看章节进度（需配置 BGM_ACCESS_TOKEN）
pnpm mokuroku pull-collection --calendar

# 6. 启动本地 SvelteKit 看板（仅绑定 127.0.0.1:4173）
pnpm mokuroku serve
```

## CLI 命令一览

| 命令 | 说明 |
| :--- | :--- |
| `pnpm mokuroku sync` | 全流程拉取最新快照、流式校验 SHA-256、流式解压、50,000 行批量事务写入备用槽位并原子切换 `data/active-db.json`，完成后自动清理 zip 与解压目录 |
| `pnpm mokuroku sync --skip-if-unchanged` | 若远端快照 `sha256` 与当前激活库一致则跳过重复导入（适合定时任务） |
| `pnpm mokuroku search <关键词> [-t 2] [-l 15]` | 基于 `sqlite-better-trigram` 的 `MATCH` 全文检索，综合标题/别名命中度、BM25、`score`、`rank`、收藏人数排序 |
| `pnpm mokuroku pull-collection [--all-types] [--calendar]` | 串行拉取个人收藏与「在看」章节进度写入独立 `data/collection.db` |
| `pnpm mokuroku serve [-p 4173]` | 构建并启动本地单机看板（默认仅监听 `127.0.0.1`） |
| `pnpm mokuroku schedule --install` | 注册 Windows 计划任务 `MokurokuWeeklySync`，每周四 `06:00` 自动增量同步周三发布的官方快照 |

## 开发与测试

```powershell
# 运行离线单元测试（Vitest + MSW，禁绝真实外网请求）
pnpm test

# 类型检查与生产构建
pnpm typecheck
pnpm build
```

## 目录结构

```text
src/
  archive/
    fetch.ts       读取 latest.json、HTTP Range 断点续传、流式 SHA-256 校验
    extract.ts     yauzl 流式解压、Zip Slip 路径越界防护、文件名变体探测
    infobox.ts     @bgm38/wiki 解析 → subject_infobox 结构化展开与 aliases 聚合、容错计数
    importer.ts    JSON Lines 流式读取 → 50,000 行事务批量导入、后置建索引与 FTS5、双库原子切换
    sync.ts        下载 → 校验 → 解压 → 导入 → 切库 → 清理临时文件全链路编排
  db/
    common/        bangumi/common 官方常量 YAML（platform / relation / staff）
    constants.ts   常量解析与落库
    schema.sql     离线快照全表与 FTS5 定义
    open.ts        加载 sqlite-better-trigram 扩展、PRAGMA 调优、双库槽位指针与独立收藏库管理
  api/
    auth.ts        访问令牌提供器抽象（.env 个人令牌，预留 OAuth 2.0 扩展）
    client.ts      Bangumi v0 客户端（固定 UA tianchu/mokuroku、串行队列、429 指数退避、封面缓存）
  search.ts        全文检索层（MATCH 查询 + 综合排序）
  web/             SvelteKit SSR 本地看板（收藏统计、评分对比、在看进度、季度新番、口味画像、未看推荐、右侧详情抽屉）
  cli.ts           mokuroku CLI 入口
test/              Vitest 离线单测 + JSONL 小样本夹具 + MSW HTTP Mock
```
