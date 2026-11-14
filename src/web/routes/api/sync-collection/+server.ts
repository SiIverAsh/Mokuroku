import { json } from '@sveltejs/kit';
import { getServerBangumiClient, getServerCollectionDb } from '../../../lib/server/db.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
  try {
    const client = getServerBangumiClient();
    const collectionDb = getServerCollectionDb();
    const result = await client.pullAllCollectionsToDb(collectionDb, {
      subjectTypes: [2],
      includeWatchingEpisodes: true
    });
    return json({
      ok: true,
      totalSaved: result.totalSaved,
      episodesSyncedSubjects: result.episodesSyncedSubjects
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      },
      { status: 400 }
    );
  }
};
