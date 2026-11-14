import { error, json } from '@sveltejs/kit';
import {
  AuthRequiredError,
  type BangumiSubjectDetail
} from '../../../../../api/client.js';
import { readApiCache } from '../../../../../db/open.js';
import {
  getServerBangumiClient,
  getServerCollectionDb
} from '../../../../lib/server/db.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
  const subjectId = Number(params.id);
  if (!Number.isInteger(subjectId) || subjectId <= 0) {
    throw error(400, '无效的条目 ID');
  }

  const body = (await request.json()) as {
    type?: number;
    rate?: number;
    ep_status?: number;
    comment?: string;
    tags?: string[];
  };

  const collectionDb = getServerCollectionDb();
  const client = getServerBangumiClient();

  const existing = collectionDb
    .prepare('SELECT * FROM collection WHERE subject_id = ?')
    .get(subjectId) as
    | {
        subject_type: number;
        type: number;
        rate: number;
        ep_status: number;
        comment: string;
        tags: string;
        subject_name: string;
        subject_name_cn: string;
        subject_eps: number;
        subject_date: string | null;
        subject_score: number | null;
        subject_rank: number | null;
        subject_platform: string;
        subject_tags_json: string;
      }
    | undefined;

  let onlineSubj = readApiCache<BangumiSubjectDetail>(
    collectionDb,
    `subject:${subjectId}`,
    true
  )?.value;
  if (!onlineSubj && !existing?.subject_name) {
    onlineSubj = await client.getSubject(subjectId).catch(() => undefined);
  }

  const nextType = body.type ?? existing?.type ?? 3;
  const nextRate =
    body.rate !== undefined
      ? Math.max(0, Math.min(10, Number(body.rate)))
      : (existing?.rate ?? 0);
  const nextEp =
    body.ep_status !== undefined
      ? Math.max(0, Math.trunc(Number(body.ep_status)))
      : (existing?.ep_status ?? 0);
  const nextComment = body.comment !== undefined ? String(body.comment) : (existing?.comment ?? '');
  const nextTags =
    body.tags !== undefined
      ? body.tags.map((t) => t.trim()).filter(Boolean)
      : existing?.tags
        ? (JSON.parse(existing.tags) as string[])
        : [];

  const nowIso = new Date().toISOString();

  if (nextType === 0) {
    collectionDb.prepare('DELETE FROM collection WHERE subject_id = ?').run(subjectId);
    return json({ ok: true, syncedOnline: false, deleted: true });
  }

  const subjectEps =
    onlineSubj?.eps || onlineSubj?.total_episodes || existing?.subject_eps || 0;
  const subjectTagsJson =
    onlineSubj?.tags && onlineSubj.tags.length > 0
      ? JSON.stringify(onlineSubj.tags)
      : (existing?.subject_tags_json ?? '[]');

  collectionDb
    .prepare(
      `INSERT INTO collection (
        subject_id, subject_type, type, rate, ep_status, vol_status,
        comment, tags, private, updated_at,
        subject_name, subject_name_cn, subject_eps, subject_date,
        subject_score, subject_rank, subject_platform, subject_tags_json
      ) VALUES (
        @subject_id, @subject_type, @type, @rate, @ep_status, 0,
        @comment, @tags, 0, @updated_at,
        @subject_name, @subject_name_cn, @subject_eps, @subject_date,
        @subject_score, @subject_rank, @subject_platform, @subject_tags_json
      )
      ON CONFLICT(subject_id) DO UPDATE SET
        type = excluded.type,
        rate = excluded.rate,
        ep_status = excluded.ep_status,
        comment = excluded.comment,
        tags = excluded.tags,
        updated_at = excluded.updated_at,
        subject_name = CASE WHEN excluded.subject_name != '' THEN excluded.subject_name ELSE collection.subject_name END,
        subject_name_cn = CASE WHEN excluded.subject_name_cn != '' THEN excluded.subject_name_cn ELSE collection.subject_name_cn END,
        subject_eps = CASE WHEN excluded.subject_eps > 0 THEN excluded.subject_eps ELSE collection.subject_eps END,
        subject_date = COALESCE(excluded.subject_date, collection.subject_date),
        subject_score = COALESCE(excluded.subject_score, collection.subject_score),
        subject_rank = COALESCE(excluded.subject_rank, collection.subject_rank),
        subject_platform = CASE WHEN excluded.subject_platform != '' THEN excluded.subject_platform ELSE collection.subject_platform END,
        subject_tags_json = CASE WHEN excluded.subject_tags_json != '[]' THEN excluded.subject_tags_json ELSE collection.subject_tags_json END`
    )
    .run({
      subject_id: subjectId,
      subject_type: onlineSubj?.type ?? existing?.subject_type ?? 2,
      type: nextType,
      rate: nextRate,
      ep_status: nextEp,
      comment: nextComment,
      tags: JSON.stringify(nextTags),
      updated_at: nowIso,
      subject_name: onlineSubj?.name ?? existing?.subject_name ?? '',
      subject_name_cn: onlineSubj?.name_cn ?? existing?.subject_name_cn ?? '',
      subject_eps: subjectEps,
      subject_date: onlineSubj?.date ?? existing?.subject_date ?? null,
      subject_score: onlineSubj?.rating?.score ?? existing?.subject_score ?? null,
      subject_rank: onlineSubj?.rating?.rank ?? existing?.subject_rank ?? null,
      subject_platform: onlineSubj?.platform ?? existing?.subject_platform ?? '',
      subject_tags_json: subjectTagsJson
    });

  let syncedOnline = false;
  let onlineWarning: string | undefined;

  try {
    await client.updateCollection(subjectId, {
      type: nextType,
      rate: nextRate,
      ep_status: nextEp,
      comment: nextComment,
      tags: nextTags
    });
    syncedOnline = true;
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      onlineWarning = '已保存至本地收藏库（未配置 BGM_ACCESS_TOKEN，未同步远端）';
    } else {
      onlineWarning = `已保存至本地收藏库，远端同步失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return json({
    ok: true,
    syncedOnline,
    warning: onlineWarning,
    collection: {
      type: nextType,
      rate: nextRate,
      epStatus: nextEp,
      comment: nextComment,
      tags: nextTags,
      updatedAt: nowIso
    }
  });
};
