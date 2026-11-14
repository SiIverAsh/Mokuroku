# Mokuroku（目録）

基于 **Bangumi v0 官方在线 API** 与 **轻量本地 SQLite 缓存（KB～MB 级）** 的个人单机动画检索与看板工具。

## 架构特点

| 模块 | 实现机制 | 存储与性能表现 |
| :--- | :--- | :--- |
| **在线数据层 (`src/api/client.ts`)** | 全量走 `https://api.bgm.tv/v0`（搜索 `/v0/search/subjects`、季度浏览与排行 `/v0/subjects`、详情 `/v0/subjects/{id}`、章节 `/v0/episodes`、角色 `/v0/subjects/{id}/characters`、关联 `/v0/subjects/{id}/subjects`、收藏读写），固定 UA `tianchu/mokuroku`，串行请求队列 + `429` 退避 | **无需下载数 GB 离线快照**；接口响应透明缓存于 `data/collection.db` 的 `api_cache`（自动 LRU 上限 400 条，体积 `< 5 MB`），封面缓存自动 LRU 上限 300 张 |
| **个人收藏与画像 (`data/collection.db`)** | 同步保存个人五态收藏、打分、在看单集进度及 `SlimSubject` 标签，实时聚合彩色 **个人口味标签云** 并重排 **高分未看推荐** | 本地数据几十 KB 级；网络波动时自动回退本地缓存保证看板可用 |
| **本地紧凑看板 (`src/web/`)** | SvelteKit SSR + 语义化彩色标签（题材/来源/动画社分色，点击任意标签联动检索）+ 评分梯队胶囊 + 右侧原位详情抽屉 (`SubjectDrawer`) | 仅绑定 `127.0.0.1` 单机自用 |

## 环境要求

- **Node.js** `>= 22.0.0`（ESM-only，内置 `.env` 与 `HTTPS_PROXY` 解析支持）
- **pnpm** `>= 10`

## 快速开始（PowerShell）

```powershell
# 1. 安装依赖
pnpm install

# 2. 配置个人令牌（及可选本地代理）
Copy-Item .env.example .env
# 前往 https://next.bgm.tv/demo/access-token 生成令牌填入 BGM_ACCESS_TOKEN
# 若本机直连 api.bgm.tv 受限，取消 .env 中 HTTPS_PROXY=http://127.0.0.1:7890 的注释

# 3. 在线检索测试
pnpm mokuroku search 葬送的芙莉莲
pnpm mokuroku search EVA -t 2

# 4. 同步个人收藏与在看章节进度
pnpm mokuroku pull-collection --calendar

# 5. 启动本地看板（默认 http://127.0.0.1:4173）
pnpm mokuroku serve
```

## CLI 命令一览

| 命令 | 说明 |
| :--- | :--- |
| `pnpm mokuroku search <关键词> [-t 2] [-s match\|rank\|score\|heat]` | 调用 Bangumi v0 在线检索并按相关性与全站口碑综合排序 |
| `pnpm mokuroku pull-collection [--all-types] [--calendar]` | 串行拉取个人收藏与在看章节进度落盘至 `data\collection.db` |
| `pnpm mokuroku serve [-p 4173]` | 构建并启动本地 SvelteKit 看板（默认监听 `127.0.0.1`） |
| `pnpm mokuroku clear-cache [--covers]` | 清理临时 API 响应缓存与封面缓存（保留个人收藏记录）并压缩本地库体积 |

## 开发与测试

```powershell
# 运行离线单元测试（Vitest + MSW Mock，零外网依赖）
pnpm test

# 类型检查与生产构建
pnpm typecheck
pnpm build
```
