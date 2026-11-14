import { json } from '@sveltejs/kit';
import { searchSubjects } from '../../../../search.js';
import { getServerArchiveDb } from '../../../lib/server/db.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  const t0 = performance.now();
  const q = (url.searchParams.get('q') ?? '').trim();
  const typeParam = url.searchParams.get('type');
  const platformParam = url.searchParams.get('platform');
  const limitParam = url.searchParams.get('limit');

  const db = getServerArchiveDb();
  if (!db || !q) {
    return json({
      query: q,
      hits: [],
      elapsedMs: Number((performance.now() - t0).toFixed(2))
    });
  }

  const hits = searchSubjects(db, q, {
    type: typeParam ? Number(typeParam) : undefined,
    platform: platformParam ? Number(platformParam) : undefined,
    limit: limitParam ? Number(limitParam) : 30
  });

  return json({
    query: q,
    hits,
    elapsedMs: Number((performance.now() - t0).toFixed(2))
  });
};
