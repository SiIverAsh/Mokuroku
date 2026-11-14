import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAppPaths } from '../../../../../config.js';
import { getServerBangumiClient } from '../../../../lib/server/db.js';
import type { RequestHandler } from './$types';

function makePlaceholderSvg(id: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="168" viewBox="0 0 120 168">
    <rect width="120" height="168" rx="4" fill="#eef1f5"/>
    <text x="60" y="82" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#8b95a5">#${id}</text>
    <text x="60" y="98" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#a3adbc">NO COVER</text>
  </svg>`;
}

export const GET: RequestHandler = async ({ params, url }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response('Invalid subject id', { status: 400 });
  }

  const { coversDir } = getAppPaths();
  const cachedPath = resolve(coversDir, `${id}.jpg`);
  if (existsSync(cachedPath) && statSync(cachedPath).size > 0) {
    const buf = readFileSync(cachedPath);
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=604800, immutable'
      }
    });
  }

  // Only attempt live download when explicitly requested (?fetch=1) or online
  const allowFetch = url.searchParams.get('offline') !== '1';
  if (allowFetch) {
    try {
      const res = await getServerBangumiClient().getCoverImage(id, 'common');
      return new Response(new Uint8Array(res.buffer), {
        headers: {
          'Content-Type': res.contentType,
          'Cache-Control': 'public, max-age=604800'
        }
      });
    } catch {
      // Fall through to SVG placeholder when offline
    }
  }

  return new Response(makePlaceholderSvg(id), {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
};
