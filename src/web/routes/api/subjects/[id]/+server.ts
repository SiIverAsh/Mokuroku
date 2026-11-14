import { error, json } from '@sveltejs/kit';
import { getSubjectDrawerDetail } from '../../../../lib/server/dashboard.js';
import {
  getServerArchiveDb,
  getServerBangumiClient,
  getServerCollectionDb
} from '../../../../lib/server/db.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw error(400, '无效的条目 ID');
  }

  const detail = getSubjectDrawerDetail(getServerArchiveDb(), getServerCollectionDb(), id);
  if (!detail) {
    throw error(404, '未找到对应条目');
  }

  return json(detail);
};

export const POST: RequestHandler = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw error(400, '无效的条目 ID');
  }

  try {
    const collectionDb = getServerCollectionDb();
    await getServerBangumiClient().refreshSubjectToDb(collectionDb, id);
    const detail = getSubjectDrawerDetail(getServerArchiveDb(), collectionDb, id);
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
