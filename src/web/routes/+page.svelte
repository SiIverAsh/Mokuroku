<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { cubicOut } from 'svelte/easing';
  import { fade, slide } from 'svelte/transition';
  import SubjectDrawer from '$lib/components/SubjectDrawer.svelte';
  import {
    getPlatformBadgeClass,
    getScoreTierClass,
    getTagBadgeClass,
    getTagTone
  } from '$lib/tag-colors.js';
  import type { SearchHit } from '../../search.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let searchInput = $state('');
  let searchTypeFilter = $state('2');
  let liveSearchHits = $state<SearchHit[] | null>(null);
  let liveSearchElapsedMs = $state<number | null>(null);
  let searching = $state(false);

  let selectedSubjectId = $state<number | null>(null);
  let syncingCollection = $state(false);
  let syncBanner = $state('');

  $effect(() => {
    if (data.searchQuery && !searchInput) {
      searchInput = data.searchQuery;
    }
  });

  const COLLECTION_BADGE: Record<number, { label: string; cls: string }> = {
    1: { label: '想看', cls: 'badge-amber' },
    2: { label: '看过', cls: 'badge-green' },
    3: { label: '在看', cls: 'badge-blue' },
    4: { label: '搁置', cls: 'badge-neutral' },
    5: { label: '抛弃', cls: 'badge-rose' }
  };

  async function runSearch(e?: Event) {
    e?.preventDefault();
    const q = searchInput.trim();
    if (!q) {
      liveSearchHits = null;
      liveSearchElapsedMs = null;
      return;
    }
    searching = true;
    try {
      const qs = new URLSearchParams({ q, limit: '30' });
      if (searchTypeFilter !== 'all') {
        qs.set('type', searchTypeFilter);
      }
      const res = await fetch(`/api/search?${qs.toString()}`);
      const payload = (await res.json()) as {
        hits: SearchHit[];
        elapsedMs: number;
          error?: string;
      };
        if (!res.ok && payload.error) {
          syncBanner = `在线检索失败: ${payload.error}`;
        }
        liveSearchHits = payload.hits ?? [];
      liveSearchElapsedMs = payload.elapsedMs;
    } finally {
      searching = false;
    }
  }

  function clearSearch() {
    searchInput = '';
    liveSearchHits = null;
    liveSearchElapsedMs = null;
  }

  function searchByTag(tagName: string, e?: MouseEvent) {
    e?.stopPropagation();
    selectedSubjectId = null;
    searchInput = tagName;
    void runSearch();
  }

  function toggleRowSubject(id: number) {
    selectedSubjectId = selectedSubjectId === id ? null : id;
  }

  async function handleSeasonChange(nextSeason: string, nextPlatform: number | null) {
    const qs = new URLSearchParams();
    qs.set('season', nextSeason);
    if (nextPlatform !== null) {
      qs.set('platform', String(nextPlatform));
    }
    await goto(`/?${qs.toString()}`, { keepFocus: true, noScroll: true });
  }

  async function bumpWatchingProgress(e: MouseEvent, subjectId: number, currentEps: number) {
    e.stopPropagation();
    await fetch(`/api/collection/${subjectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 3,
        ep_status: currentEps + 1
      })
    });
    await invalidateAll();
  }

  async function handlePullCollection() {
    syncingCollection = true;
    syncBanner = '';
    try {
      const res = await fetch('/api/sync-collection', { method: 'POST' });
      const out = (await res.json()) as {
        ok: boolean;
        totalSaved?: number;
        episodesSyncedSubjects?: number;
        error?: string;
      };
      if (!res.ok || !out.ok) {
        syncBanner = out.error ?? '同步失败';
        return;
      }
      syncBanner = `已同步 ${out.totalSaved ?? 0} 条收藏，更新 ${out.episodesSyncedSubjects ?? 0} 部在看章节进度`;
      await invalidateAll();
    } catch (err) {
      syncBanner = err instanceof Error ? err.message : String(err);
    } finally {
      syncingCollection = false;
    }
  }

  function formatAirBadge(nextEp: PageData['watchingList'][number]['nextEpisode']): {
    text: string;
    cls: string;
  } {
    if (!nextEp) return { text: '已追平/完结', cls: 'badge-neutral' };
    if (nextEp.airStatus === 'today') return { text: `今日 EP.${nextEp.sort}`, cls: 'badge-rose' };
    if (nextEp.airStatus === 'upcoming') {
      return {
        text: `EP.${nextEp.sort} · ${nextEp.airdate} (${nextEp.daysDiff}天后)`,
        cls: 'badge-amber'
      };
    }
    if (nextEp.airStatus === 'aired') {
      return {
        text: `EP.${nextEp.sort} 已播 (${nextEp.airdate})`,
        cls: 'badge-green'
      };
    }
    return { text: `EP.${nextEp.sort} 待定`, cls: 'badge-neutral' };
  }

  let displayedSearchHits = $derived(
    liveSearchHits !== null ? liveSearchHits : data.searchQuery ? data.searchResults : null
  );
  let maxDistPct = $derived(
    Math.max(1, ...data.scoreDistribution.flatMap((b) => [b.myPct, b.sitePct]))
  );
</script>

<!-- 顶部导航与即时在线检索 -->
<header class="topbar">
  <div class="brand">
    <span class="brand-title">Mokuroku 目録</span>
    <span
      class="brand-meta"
      title="模式: Bangumi v0 在线直连 + 轻量本地缓存 ({data.syncSummary.cachedEntries} 条缓存)"
    >
      在线直连 · 缓存 {data.syncSummary.cachedEntries} · SSR {data.renderMs}ms
    </span>
  </div>

  <form class="search-bar" onsubmit={runSearch}>
    <select class="select" bind:value={searchTypeFilter} aria-label="检索类型">
      <option value="2">动画</option>
      <option value="all">全部类型</option>
      <option value="1">书籍</option>
      <option value="4">游戏</option>
      <option value="3">音乐</option>
      <option value="6">三次元</option>
    </select>
    <input
      class="input search-input"
      type="search"
      placeholder="在线检索 Bangumi 原名 / 中文名 / 别名（如：葬送的芙莉莲、EVA、進撃）..."
      bind:value={searchInput}
    />
    <button class="btn btn-primary" type="submit" disabled={searching}>
      {#if searching}
        <span class="spin-dot" aria-hidden="true"></span>检索中
      {:else}
        检索
      {/if}
    </button>
    {#if displayedSearchHits !== null}
      <button class="btn" type="button" onclick={clearSearch} transition:fade={{ duration: 140 }}>清空</button>
    {/if}
  </form>

  <div style="display: flex; align-items: center; gap: 6px;">
    <button
      class="btn"
      onclick={handlePullCollection}
      disabled={syncingCollection}
      title={data.syncSummary.lastCollectionSync
        ? `上次同步: ${data.syncSummary.lastCollectionSync}`
        : '拉取 Bangumi 个人收藏与在看进度'}
    >
      {#if syncingCollection}
        <span class="spin-dot" aria-hidden="true"></span>同步中...
      {:else}
        同步收藏
      {/if}
    </button>
  </div>
</header>

{#if data.onlineError}
  <div
    style="background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 6px; padding: 6px 10px; margin-bottom: 10px;"
    transition:slide={{ duration: 180, easing: cubicOut }}
  >
    {data.onlineError}（若本机直连 api.bgm.tv 受限，请在 .env 配置 HTTPS_PROXY）
  </div>
{/if}

{#if syncBanner}
  <div
    style="background: var(--surface); border: 1px solid var(--accent-border); border-radius: 6px; padding: 6px 10px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;"
    transition:slide={{ duration: 180, easing: cubicOut }}
  >
    <span>{syncBanner}</span>
    <button class="btn btn-xs" onclick={() => (syncBanner = '')}>关闭</button>
  </div>
{/if}

<!-- 全文检索结果面板（有查询时原位展开，点击行开右侧抽屉） -->
{#if displayedSearchHits !== null}
  <section class="panel" transition:slide={{ duration: 220, easing: cubicOut }}>
    <div class="panel-header">
      <div class="panel-title">
        <span>检索结果 ({displayedSearchHits.length})</span>
        {#if liveSearchElapsedMs !== null}
          <span class="badge badge-neutral">{liveSearchElapsedMs}ms</span>
        {/if}
      </div>
    </div>
    <div class="table-wrap">
      {#if displayedSearchHits.length === 0}
        <div style="padding: 12px; color: var(--text-muted);">无匹配条目</div>
      {:else}
        <table class="compact-table">
          <thead>
            <tr>
              <th style="width: 68px;">类型</th>
              <th style="width: 30%;">条目名称</th>
              <th style="width: 24%;">原名 / 命中别名</th>
              <th style="width: 20%;">核心标签</th>
              <th style="width: 86px;">首播/发行</th>
              <th class="num" style="width: 58px;">评分</th>
              <th class="num" style="width: 68px;">排名</th>
              <th class="num" style="width: 76px;">收藏人数</th>
            </tr>
          </thead>
          <tbody>
            {#each displayedSearchHits as hit (hit.id)}
              <tr
                data-subject-trigger
                class:is-selected={selectedSubjectId === hit.id}
                onclick={() => toggleRowSubject(hit.id)}
              >
                <td>
                  <span class={getPlatformBadgeClass(hit.platformLabel || hit.typeLabel)}>
                    {hit.platformLabel || hit.typeLabel}
                  </span>
                </td>
                <td title="{hit.nameCn || hit.name} (#{hit.id})">
                  <span class="subj-title">{hit.nameCn || hit.name}</span>
                </td>
                <td
                  style="color: var(--text-secondary);"
                  title={[hit.name, ...hit.aliases].filter(Boolean).join(' / ')}
                >
                  {hit.name}{hit.aliases.length > 0 ? ` · ${hit.aliases.slice(0, 2).join(' / ')}` : ''}
                </td>
                <td title={hit.tags.map((t) => t.name).join(' / ')}>
                  <div class="tag-inline-list">
                    {#each hit.tags.slice(0, 3) as t}
                      <span
                        class="{getTagBadgeClass(t.name)} badge-clickable"
                        role="button"
                        tabindex="0"
                        onclick={(e) => searchByTag(t.name, e)}
                        onkeydown={(e) => e.key === 'Enter' && searchByTag(t.name)}
                        title="点击检索标签：{t.name}"
                      >
                        {t.name}
                      </span>
                    {/each}
                  </div>
                </td>
                <td style="color: var(--text-secondary);">{hit.date ?? '-'}</td>
                <td class="num">
                  {#if hit.score}
                    <span class={getScoreTierClass(hit.score)}>{hit.score.toFixed(1)}</span>
                  {:else}
                    <span class="score-none">-</span>
                  {/if}
                </td>
                <td class="num" style="color: var(--text-secondary);">
                  {hit.rank ? `#${hit.rank}` : '-'}
                </td>
                <td class="num" style="color: var(--text-secondary);">
                  {hit.favTotal.toLocaleString()}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </section>
{/if}

<!-- 1. 我的收藏分状态统计 KPI 条 -->
<section class="kpi-strip" aria-label="收藏分状态统计">
  <div class="kpi-card">
    <span class="kpi-label">在看</span>
    <span class="kpi-value" style="color: var(--accent);">{data.collectionStats.doing}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">看过</span>
    <span class="kpi-value" style="color: var(--green);">{data.collectionStats.done}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">想看</span>
    <span class="kpi-value" style="color: var(--amber);">{data.collectionStats.wish}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">搁置</span>
    <span class="kpi-value">{data.collectionStats.onHold}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">抛弃</span>
    <span class="kpi-value" style="color: var(--rose);">{data.collectionStats.dropped}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">收藏合计</span>
    <span class="kpi-value">{data.collectionStats.total}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">我的均分 ({data.collectionStats.ratedCount})</span>
    <span class="kpi-value">{data.collectionStats.myAvgScore?.toFixed(2) ?? '-'}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">对应全站均分</span>
    <span class="kpi-value">{data.collectionStats.siteAvgScore?.toFixed(2) ?? '-'}</span>
  </div>
</section>

<!-- 2. 在看列表（含章节进度 + 下一话放送时间） & 评分分布（我的 vs 全站） + 口味画像 -->
<div class="grid-2col">
  <!-- 左：在看列表 -->
  <section class="panel">
    <div class="panel-header">
      <div class="panel-title">
        <span>在看进度与下一话放送</span>
        <span class="badge badge-blue">{data.watchingList.length}</span>
      </div>
    </div>
    <div class="table-wrap">
      {#if data.watchingList.length === 0}
        <div style="padding: 14px 12px; color: var(--text-muted);">
          暂无「在看」番剧（可在任意条目抽屉中设为「在看」，或配置 .env 后点击「同步收藏」）
        </div>
      {:else}
        <table class="compact-table">
          <thead>
            <tr>
              <th style="width: 34%;">番剧</th>
              <th style="width: 118px;">章节进度</th>
              <th style="width: 34%;">下一话放送时间</th>
              <th class="num" style="width: 54px;">全站</th>
              <th style="width: 58px; text-align: center;">操作</th>
            </tr>
          </thead>
          <tbody>
            {#each data.watchingList as item (item.subjectId)}
              {@const airBadge = formatAirBadge(item.nextEpisode)}
              <tr
                data-subject-trigger
                class:is-selected={selectedSubjectId === item.subjectId}
                onclick={() => toggleRowSubject(item.subjectId)}
              >
                <td title="{item.nameCn || item.name} ({item.name})">
                  <span class="subj-title">{item.nameCn || item.name}</span>
                </td>
                <td>
                  <div class="prog-cell" title="已看 {item.watchedEps} / 共 {item.totalEps || '?'} 话 ({item.progressPct}%)">
                    <div class="prog-track">
                      <div class="prog-fill" style="width: {item.progressPct}%;"></div>
                    </div>
                    <span style="font-variant-numeric: tabular-nums; font-size: 11px;">
                      {item.watchedEps}/{item.totalEps || '?'}
                    </span>
                  </div>
                </td>
                <td title={item.nextEpisode ? `EP.${item.nextEpisode.sort} ${item.nextEpisode.title}` : ''}>
                  <span class="badge {airBadge.cls}">{airBadge.text}</span>
                </td>
                <td class="num">
                  {#if item.score}
                    <span class={getScoreTierClass(item.score)}>{item.score.toFixed(1)}</span>
                  {:else}
                    <span class="score-none">-</span>
                  {/if}
                </td>
                <td style="text-align: center;">
                  <button
                    class="btn btn-xs"
                    onclick={(e) => bumpWatchingProgress(e, item.subjectId, item.watchedEps)}
                    title="观看进度 +1 话"
                  >
                    +1话
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </section>

  <!-- 右：评分分布（我的 vs 全站） + 个人口味标签云 -->
  <div style="display: flex; flex-direction: column; gap: 10px;">
    <section class="panel" style="margin-bottom: 0;">
      <div class="panel-header">
        <div class="panel-title">
          <span>评分分布（我的 vs 全站）</span>
        </div>
        <div style="display: flex; gap: 8px; font-size: 11px; color: var(--text-secondary);">
          <span><span style="display:inline-block;width:8px;height:8px;background:var(--accent);border-radius:2px;margin-right:3px;"></span>我的</span>
          <span><span style="display:inline-block;width:8px;height:8px;background:#94a3b8;border-radius:2px;margin-right:3px;"></span>{data.scoreDistributionBasis === 'my_collection' ? '同批全站' : '全站Top500'}</span>
        </div>
      </div>
      <div class="panel-body">
        <div class="dist-list">
          {#each data.scoreDistribution as b}
            <div
              class="dist-row"
              title="{b.score}分：我的 {b.myCount} 部 ({b.myPct}%) | 全站 {b.siteCount.toLocaleString()} 人 ({b.sitePct}%)"
            >
              <span style="color: var(--text-secondary); font-weight: 600;">{b.score}★</span>
              <div class="dist-bars">
                <div class="bar-track">
                  <div class="bar-fill-my" style="width: {(b.myPct / maxDistPct) * 100}%;"></div>
                </div>
                <div class="bar-track">
                  <div class="bar-fill-site" style="width: {(b.sitePct / maxDistPct) * 100}%;"></div>
                </div>
              </div>
              <span style="text-align: right; color: var(--text-secondary);">
                {b.myPct.toFixed(0)}% / {b.sitePct.toFixed(0)}%
              </span>
            </div>
          {/each}
        </div>
      </div>
    </section>

    <section class="panel" style="margin-bottom: 0;">
      <div class="panel-header">
        <div class="panel-title">
          <span>个人口味画像（偏好标签云）</span>
          <span class="badge badge-neutral">{data.tasteTags.length}</span>
        </div>
      </div>
      <div class="panel-body">
        {#if data.tasteTags.length === 0}
          <div style="color: var(--text-muted);">同步或添加收藏后自动聚合偏好标签云</div>
        {:else}
          <div class="tag-cloud">
            {#each data.tasteTags.slice(0, 28) as tag}
              <button
                type="button"
                class="badge badge-{getTagTone(tag.name)} badge-clickable"
                style="height: 22px; gap: 4px; padding: 0 7px;"
                onclick={(e) => searchByTag(tag.name, e)}
                title="收藏命中 {tag.count} 部 | 加权偏好 {tag.weight}{tag.avgRate ? ` | 我的均分 ${tag.avgRate}` : ''}"
              >
                <span>{tag.name}</span>
                <span style="opacity: 0.65; font-variant-numeric: tabular-nums;">{tag.count}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </section>
  </div>
</div>

<!-- 3. 本季新番（按 date + platform 筛 type=2） -->
<section class="panel">
  <div class="panel-header">
    <div class="panel-title">
      <span>季度新番</span>
      <span class="badge badge-neutral">{data.seasonalAnime.length}</span>
    </div>
    <div style="display: flex; align-items: center; gap: 6px;">
      <select
        class="select"
        value={data.seasonFilter.current}
        onchange={(e) =>
          handleSeasonChange((e.currentTarget as HTMLSelectElement).value, data.seasonFilter.platform)}
        aria-label="选择季度"
      >
        {#each data.seasonFilter.options as s}
          <option value={s}>{s}</option>
        {/each}
      </select>

      <select
        class="select"
        value={data.seasonFilter.platform === null ? '' : String(data.seasonFilter.platform)}
        onchange={(e) => {
          const val = (e.currentTarget as HTMLSelectElement).value;
          void handleSeasonChange(data.seasonFilter.current, val === '' ? null : Number(val));
        }}
        aria-label="筛选平台"
      >
        <option value="">全部平台</option>
        <option value="1">TV</option>
        <option value="5">WEB</option>
        <option value="3">剧场版</option>
        <option value="2">OVA</option>
      </select>
    </div>
  </div>

  <div class="table-wrap">
    {#if data.seasonalAnime.length === 0}
      <div style="padding: 12px; color: var(--text-muted);">该季度与平台筛选下暂无条目</div>
    {:else}
      <table class="compact-table">
        <thead>
          <tr>
            <th style="width: 70px;">平台</th>
            <th style="width: 30%;">番剧名称</th>
            <th style="width: 16%;">动画制作</th>
            <th style="width: 22%;">标签</th>
            <th style="width: 88px;">开播日</th>
            <th class="num" style="width: 58px;">评分</th>
            <th class="num" style="width: 72px;">全站在看</th>
            <th style="width: 68px; text-align: center;">我的状态</th>
          </tr>
        </thead>
        <tbody>
          {#each data.seasonalAnime as item (item.id)}
            <tr
              data-subject-trigger
              class:is-selected={selectedSubjectId === item.id}
              onclick={() => toggleRowSubject(item.id)}
            >
              <td><span class={getPlatformBadgeClass(item.platformLabel)}>{item.platformLabel}</span></td>
              <td title="{item.nameCn || item.name} | {item.name}">
                <span class="subj-title">{item.nameCn || item.name}</span>
                {#if item.nameCn && item.name !== item.nameCn}
                  <span class="subj-sub">{item.name}</span>
                {/if}
              </td>
              <td style="color: var(--text-secondary);" title={item.studio}>{item.studio || '-'}</td>
              <td title={item.tags.join(' / ')}>
                <div class="tag-inline-list">
                  {#each item.tags.slice(0, 3) as t}
                    <span
                      class="{getTagBadgeClass(t)} badge-clickable"
                      role="button"
                      tabindex="0"
                      onclick={(e) => searchByTag(t, e)}
                      onkeydown={(e) => e.key === 'Enter' && searchByTag(t)}
                      title="点击检索标签：{t}"
                    >
                      {t}
                    </span>
                  {/each}
                </div>
              </td>
              <td style="color: var(--text-secondary);">{item.date}</td>
              <td class="num">
                {#if item.score}
                  <span class={getScoreTierClass(item.score)}>{item.score.toFixed(1)}</span>
                {:else}
                  <span class="score-none">-</span>
                {/if}
              </td>
              <td class="num" style="color: var(--text-secondary);">
                {item.favDoing.toLocaleString()}
              </td>
              <td style="text-align: center;">
                {#if item.myCollectionType && COLLECTION_BADGE[item.myCollectionType]}
                  <span class="badge {COLLECTION_BADGE[item.myCollectionType].cls}">
                    {COLLECTION_BADGE[item.myCollectionType].label}
                  </span>
                {:else}
                  <span style="color: var(--text-muted);">-</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

<!-- 4. 高分未看推荐（score 高 + rank 靠前 + 不在收藏里 + 标签匹配偏好） -->
<section class="panel">
  <div class="panel-header">
    <div class="panel-title">
      <span>高分未看推荐</span>
      <span class="badge badge-purple">{data.recommendations.length}</span>
    </div>
  </div>
  <div class="table-wrap">
    {#if data.recommendations.length === 0}
      <div style="padding: 12px; color: var(--text-muted);">暂无推荐候选</div>
    {:else}
      <table class="compact-table">
        <thead>
          <tr>
            <th class="num" style="width: 64px;">排名</th>
            <th style="width: 70px;">平台</th>
            <th style="width: 32%;">推荐番剧</th>
            <th style="width: 28%;">命中偏好 / 核心标签</th>
            <th style="width: 88px;">年份/首播</th>
            <th class="num" style="width: 60px;">全站分</th>
            <th class="num" style="width: 78px;">收藏人数</th>
            <th class="num" style="width: 72px;">推荐指数</th>
          </tr>
        </thead>
        <tbody>
          {#each data.recommendations as rec (rec.id)}
            <tr
              data-subject-trigger
              class:is-selected={selectedSubjectId === rec.id}
              onclick={() => toggleRowSubject(rec.id)}
            >
              <td class="num" style="color: var(--purple); font-weight: 600;">#{rec.rank}</td>
              <td><span class={getPlatformBadgeClass(rec.platformLabel)}>{rec.platformLabel}</span></td>
              <td title="{rec.nameCn || rec.name} | {rec.name}">
                <span class="subj-title">{rec.nameCn || rec.name}</span>
                {#if rec.nameCn && rec.name !== rec.nameCn}
                  <span class="subj-sub">{rec.name}</span>
                {/if}
              </td>
              <td title={(rec.matchedTags.length > 0 ? rec.matchedTags : rec.topTags).join(' / ')}>
                <div class="tag-inline-list">
                  {#if rec.matchedTags.length > 0}
                    {#each rec.matchedTags.slice(0, 4) as mt}
                      <span
                        class="{getTagBadgeClass(mt)} badge-matched badge-clickable"
                        role="button"
                        tabindex="0"
                        onclick={(e) => searchByTag(mt, e)}
                        onkeydown={(e) => e.key === 'Enter' && searchByTag(mt)}
                        title="命中偏好 · 点击检索：{mt}"
                      >
                        ★ {mt}
                      </span>
                    {/each}
                  {:else}
                    {#each rec.topTags.slice(0, 3) as tt}
                      <span
                        class="{getTagBadgeClass(tt)} badge-clickable"
                        role="button"
                        tabindex="0"
                        onclick={(e) => searchByTag(tt, e)}
                        onkeydown={(e) => e.key === 'Enter' && searchByTag(tt)}
                        title="点击检索标签：{tt}"
                      >
                        {tt}
                      </span>
                    {/each}
                  {/if}
                </div>
              </td>
              <td style="color: var(--text-secondary);">{rec.date ?? '-'}</td>
              <td class="num">
                <span class={getScoreTierClass(rec.score)}>{rec.score.toFixed(1)}</span>
              </td>
              <td class="num" style="color: var(--text-secondary);">
                {rec.favTotal.toLocaleString()}
              </td>
              <td class="num" style="color: var(--text-secondary);">{rec.recScore.toFixed(1)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

<SubjectDrawer
  subjectId={selectedSubjectId}
  onClose={() => (selectedSubjectId = null)}
  onSelectSubject={(id) => (selectedSubjectId = id)}
  onSearchTag={(tag) => searchByTag(tag)}
  onCollectionSaved={() => void invalidateAll()}
/>
