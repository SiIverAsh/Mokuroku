import { getDashboardData } from '$lib/server/dashboard.js';
import { getServerArchiveDb, getServerCollectionDb } from '$lib/server/db.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const season = url.searchParams.get('season') ?? undefined;
  const platformRaw = url.searchParams.get('platform');
  const platform =
    platformRaw !== null && platformRaw !== '' ? Number(platformRaw) : null;
  const q = url.searchParams.get('q') ?? undefined;
  const typeRaw = url.searchParams.get('type');
  const searchType =
    typeRaw !== null && typeRaw !== '' ? Number(typeRaw) : null;

  return getDashboardData(getServerArchiveDb(), getServerCollectionDb(), {
    season,
    platform,
    q,
    searchType
  });
};
