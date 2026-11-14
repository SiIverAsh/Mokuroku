<script lang="ts">
  import type { SubjectDrawerDetail } from '$lib/server/dashboard.js';

  let {
    subjectId = null,
    onClose,
    onSelectSubject,
    onCollectionSaved
  }: {
    subjectId: number | null;
    onClose: () => void;
    onSelectSubject: (id: number) => void;
    onCollectionSaved: () => void;
  } = $props();

  let loading = $state(false);
  let refreshing = $state(false);
  let saving = $state(false);
  let errorMsg = $state('');
  let statusNotice = $state('');
  let detail = $state<SubjectDrawerDetail | null>(null);

  let editType = $state(0);
  let editRate = $state(0);
  let editEpStatus = $state(0);
  let editComment = $state('');

  const PRIORITY_INFOBOX_KEYS = [
    '中文名',
    '话数',
    '放送开始',
    '放送星期',
    '动画制作',
    '导演',
    '原作',
    '系列构成',
    '脚本',
    '人物设定',
    '音乐',
    '官方网站'
  ];

  $effect(() => {
    if (subjectId !== null) {
      void loadDetail(subjectId);
    } else {
      detail = null;
    }
  });

  async function loadDetail(id: number) {
    loading = true;
    errorMsg = '';
    statusNotice = '';
    try {
      const res = await fetch(`/api/subjects/${id}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as SubjectDrawerDetail;
      detail = data;
      editType = data.myCollection.type;
      editRate = data.myCollection.rate;
      editEpStatus = data.myCollection.epStatus;
      editComment = data.myCollection.comment;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function handleSaveCollection() {
    if (!detail) return;
    saving = true;
    statusNotice = '';
    try {
      const res = await fetch(`/api/collection/${detail.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: Number(editType),
          rate: Number(editRate),
          ep_status: Number(editEpStatus),
          comment: editComment
        })
      });
      const out = (await res.json()) as {
        ok: boolean;
        syncedOnline?: boolean;
        warning?: string;
        error?: string;
      };
      if (!res.ok || !out.ok) {
        statusNotice = out.error ?? '保存失败';
        return;
      }
      statusNotice = out.warning ? out.warning : '已同步保存';
      await loadDetail(detail.id);
      onCollectionSaved();
    } catch (e) {
      statusNotice = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function handleForceRefresh() {
    if (!detail) return;
    refreshing = true;
    statusNotice = '';
    try {
      const res = await fetch(`/api/subjects/${detail.id}`, { method: 'POST' });
      const out = (await res.json()) as {
        ok: boolean;
        detail?: SubjectDrawerDetail;
        error?: string;
      };
      if (!res.ok || !out.ok || !out.detail) {
        statusNotice = `远端刷新失败: ${out.error ?? res.statusText}`;
        return;
      }
      detail = out.detail;
      statusNotice = '已从 Bangumi v0 刷新最新条目数据';
      onCollectionSaved();
    } catch (e) {
      statusNotice = `远端刷新失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      refreshing = false;
    }
  }

  function sortedInfobox(items: Array<{ key: string; values: string[] }>) {
    return [...items]
      .filter((x) => x.key !== '别名')
      .sort((a, b) => {
        const ia = PRIORITY_INFOBOX_KEYS.indexOf(a.key);
        const ib = PRIORITY_INFOBOX_KEYS.indexOf(b.key);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
      })
      .slice(0, 18);
  }
</script>

{#if subjectId !== null}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="drawer-backdrop" onclick={onClose}></div>

  <aside class="drawer-panel" aria-label="条目详情">
    <div class="drawer-header">
      <div style="min-width: 0; overflow: hidden;">
        <div class="subj-title" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          {detail ? detail.nameCn || detail.name : `#${subjectId}`}
        </div>
        {#if detail && detail.nameCn && detail.name !== detail.nameCn}
          <div style="font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            {detail.name}
          </div>
        {/if}
      </div>
      <div style="display: flex; gap: 6px; align-items: center; flex-shrink: 0;">
        <button class="btn btn-xs" onclick={handleForceRefresh} disabled={refreshing || loading} title="通过 GET /v0/subjects/{subjectId} 强制拉取在线最新数据">
          {refreshing ? '刷新中...' : '强制刷新'}
        </button>
        <a
          class="btn btn-xs"
          href="https://bgm.tv/subject/{subjectId}"
          target="_blank"
          rel="noreferrer"
          style="text-decoration: none;"
        >
          Bangumi ↗
        </a>
        <button class="btn btn-xs" onclick={onClose}>关闭</button>
      </div>
    </div>

    <div class="drawer-body">
      {#if loading}
        <div style="color: var(--text-muted); padding: 16px 0;">读取本地库中...</div>
      {:else if errorMsg}
        <div style="color: var(--rose); padding: 12px 0;">{errorMsg}</div>
      {:else if detail}
        <div class="drawer-hero">
          <img
            class="drawer-cover"
            src="/api/covers/{detail.id}"
            alt={detail.name}
            loading="lazy"
          />
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px;">
              <span class="badge badge-blue">{detail.typeLabel}{detail.platformLabel ? ` · ${detail.platformLabel}` : ''}</span>
              {#if detail.score}
                <span class="badge badge-amber">★ {detail.score.toFixed(1)}</span>
              {/if}
              {#if detail.rank}
                <span class="badge badge-purple">Rank #{detail.rank}</span>
              {/if}
              {#if detail.date}
                <span class="badge badge-neutral">{detail.date}</span>
              {/if}
            </div>

            <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 6px;">
              想看 {detail.favorite.wish} · 看过 {detail.favorite.done} · 在看 {detail.favorite.doing} · 搁置 {detail.favorite.on_hold} · 抛弃 {detail.favorite.dropped}
            </div>

            {#if detail.aliases.length > 0}
              <div
                style="font-size: 11px; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;"
                title={detail.aliases.join(' / ')}
              >
                别名：{detail.aliases.join(' / ')}
              </div>
            {/if}

            {#if detail.refreshedAt}
              <div style="font-size: 11px; color: var(--green); margin-top: 4px;">
                在线覆盖时间：{detail.refreshedAt.slice(0, 19).replace('T', ' ')}
              </div>
            {/if}
          </div>
        </div>

        <!-- 个人收藏与进度控制 -->
        <div class="drawer-section" style="margin-top: 4px;">
          <div class="drawer-section-title">我的收藏与进度</div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
            <select class="select" bind:value={editType}>
              <option value={0}>未收藏</option>
              <option value={1}>想看</option>
              <option value={3}>在看</option>
              <option value={2}>看过</option>
              <option value={4}>搁置</option>
              <option value={5}>抛弃</option>
            </select>

            <select class="select" bind:value={editRate} title="我的评分">
              <option value={0}>未评分</option>
              {#each [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as r}
                <option value={r}>{r} 分</option>
              {/each}
            </select>

            <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-secondary);">
              进度
              <input
                class="input"
                type="number"
                min="0"
                max="9999"
                style="width: 64px;"
                bind:value={editEpStatus}
              />
              话
            </label>

            <button class="btn btn-primary" onclick={handleSaveCollection} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>

          <input
            class="input"
            style="width: 100%; margin-top: 6px;"
            placeholder="短评备注（可选）"
            bind:value={editComment}
          />

          {#if statusNotice}
            <div style="font-size: 11px; color: var(--accent); margin-top: 4px;">{statusNotice}</div>
          {/if}
        </div>

        <!-- 标签 -->
        {#if detail.tags.length > 0}
          <div class="drawer-section">
            <div class="drawer-section-title">标签</div>
            <div style="display: flex; flex-wrap: wrap; gap: 4px;">
              {#each detail.tags.slice(0, 16) as tag}
                <span class="badge badge-neutral" title="标注人数 {tag.count}">
                  {tag.name} <span style="opacity: 0.6; margin-left: 3px;">{tag.count}</span>
                </span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- 章节列表 -->
        {#if detail.episodes.length > 0}
          <div class="drawer-section">
            <div class="drawer-section-title">章节 ({detail.episodes.filter((e) => e.type === 0).length} 正篇)</div>
            <div class="ep-grid">
              {#each detail.episodes.filter((e) => e.type === 0).slice(0, 60) as ep}
                <div
                  class="ep-pill {ep.watched ? 'watched' : ''}"
                  title="EP.{ep.sort} {ep.nameCn || ep.name} | 放送: {ep.airdate || '未知'}"
                >
                  {ep.sort}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- 结构化 Infobox -->
        {#if detail.infobox.length > 0}
          <div class="drawer-section">
            <div class="drawer-section-title">制作信息 (Infobox)</div>
            <div class="kv-grid">
              {#each sortedInfobox(detail.infobox) as row}
                <div class="kv-key" title={row.key}>{row.key}</div>
                <div class="kv-val">{row.values.join(' / ')}</div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- 角色与 CV -->
        {#if detail.characters.length > 0}
          <div class="drawer-section">
            <div class="drawer-section-title">角色与声优</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px;">
              {#each detail.characters.slice(0, 10) as ch}
                <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="{ch.name} ({ch.cvNames.join(' / ')})">
                  <span style="font-weight: 500;">{ch.name}</span>
                  {#if ch.cvNames.length > 0}
                    <span style="color: var(--text-muted); font-size: 11px;"> CV: {ch.cvNames.join('·')}</span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- 关联条目（原位切换抽屉） -->
        {#if detail.relations.length > 0}
          <div class="drawer-section">
            <div class="drawer-section-title">关联条目</div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
              {#each detail.relations.slice(0, 12) as rel}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 6px; border-radius: 4px; cursor: pointer; background: var(--surface-alt);"
                  onclick={() => onSelectSubject(rel.relatedId)}
                  title={rel.name}
                >
                  <div style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <span class="badge badge-blue" style="margin-right: 5px;">{rel.relationLabel}</span>
                    <span>{rel.nameCn || rel.name}</span>
                  </div>
                  <span style="font-size: 11px; color: var(--text-muted); flex-shrink: 0;">
                    {rel.typeLabel}{rel.score ? ` · ★${rel.score.toFixed(1)}` : ''}
                  </span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if detail.summary}
          <div class="drawer-section">
            <div class="drawer-section-title">简介</div>
            <div style="white-space: pre-line; color: var(--text-secondary); font-size: 12px;">
              {detail.summary}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  </aside>
{/if}
