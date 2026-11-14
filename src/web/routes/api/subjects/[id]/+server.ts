import { error, json } from '@sveltejs/kit';
import { getSubjectDrawerDetail } from '../../../../lib/server/dashboard.js';
import {
  getServerBangumiClient,
  getServerCollectionDb
} from '../../../../lib/server/db.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw error(400, '无效的条目 ID');
  }

  const detail = await getSubjectDrawerDetail(
    getServerCollectionDb(),
    getServerBangumiClient(),
    id
  );
  if (!detail) {
    throw error(502, '无法从 Bangumi 在线获取该条目详情（请检查网络或代理设置）');
  }

  return json(detail);
};

export const POST: RequestHandler = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw error(400, '无效的条目 ID');
  }

  try {
    const detail = await getSubjectDrawerDetail(
      getServerCollectionDb(),
      getServerBangumiClient(),
      id,
      { forceRefresh: true }
    );
    if (!detail) {
      return json({ ok: false, error: '在线刷新未返回有效数据' }, { status: 502 });
    }
    return json({ ok: true, detail });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      },
      { status: 502 }
    );
  }
};
