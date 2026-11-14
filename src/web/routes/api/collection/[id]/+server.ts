import { error, json } from '@sveltejs/kit';
import { AuthRequiredError } from '../../../../../api/client.js';
import {
  getServerArchiveDb,
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
  const archiveDb = getServerArchiveDb();

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
      }
    | undefined;

  const archiveSubj = archiveDb
    ? (archiveDb
        .prepare('SELECT type, name, name_cn, date, score FROM subject WHERE id = ?')
        .get(subjectId) as
        | {
            type: number;
            name: string;
            name_cn: string;
            date: string | null;
            score: number | null;
          }
        | undefined)
    : undefined;

  const nextType = body.type ?? existing?.type ?? 3;
  const nextRate = body.rate !== undefined ? Math.max(0, Math.min(10, Number(body.rate))) : (existing?.rate ?? 0);
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

  collectionDb
    .prepare(
      `INSERT INTO collection (
        subject_id, subject_type, type, rate, ep_status, vol_status,
        comment, tags, private, updated_at,
        subject_name, subject_name_cn, subject_eps, subject_date, subject_score
      ) VALUES (
        @subject_id, @subject_type, @type, @rate, @ep_status, 0,
        @comment, @tags, 0, @updated_at,
        @subject_name, @subject_name_cn, 0, @subject_date, @subject_score
      )
      ON CONFLICT(subject_id) DO UPDATE SET
        type = excluded.type,
        rate = excluded.rate,
        ep_status = excluded.ep_status,
        comment = excluded.comment,
        tags = excluded.tags,
        updated_at = excluded.updated_at`
    )
    .run({
      subject_id: subjectId,
      subject_type: archiveSubj?.type ?? existing?.subject_type ?? 2,
      type: nextType,
      rate: nextRate,
      ep_status: nextEp,
      comment: nextComment,
      tags: JSON.stringify(nextTags),
      updated_at: nowIso,
      subject_name: archiveSubj?.name ?? existing?.subject_name ?? '',
      subject_name_cn: archiveSubj?.name_cn ?? existing?.subject_name_cn ?? '',
      subject_date: archiveSubj?.date ?? null,
      subject_score: archiveSubj?.score ?? null
    });

  let syncedOnline = false;
  let onlineWarning: string | undefined;

  try {
    const client = getServerBangumiClient();
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
