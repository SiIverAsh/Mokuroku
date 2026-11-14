import { json } from '@sveltejs/kit';
import { getServerBangumiClient, getServerCollectionDb } from '../../../lib/server/db.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const db = getServerCollectionDb();
  const rows = db
    .prepare(
      'SELECT weekday_id, subject_id, name, name_cn, air_date, score, rank, fetched_at FROM calendar_cache ORDER BY weekday_id ASC, COALESCE(score, 0) DESC'
    )
    .all();
  return json({ items: rows });
};

export const POST: RequestHandler = async () => {
  try {
    const db = getServerCollectionDb();
    const days = await getServerBangumiClient().syncCalendarToDb(db);
    return json({ ok: true, daysCount: days.length });
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
};
