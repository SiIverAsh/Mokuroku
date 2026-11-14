import { parse2 } from '@bgm38/wiki';

export interface InfoboxRow {
  subjectId: number;
  ord: number;
  key: string;
  subKey: string | null;
  value: string;
}

export interface InfoboxParseFailureSample {
  subjectId: number;
  reason: string;
}

export interface InfoboxParseStats {
  total: number;
  succeeded: number;
  failed: number;
  empty: number;
  sampleErrors: InfoboxParseFailureSample[];
}

export interface ParsedSubjectInfobox {
  ok: boolean;
  rows: InfoboxRow[];
  aliases: string[];
  error?: string;
}

const ALIAS_KEYS = new Set([
  '别名',
  '中文名',
  '简体中文名',
  '繁体中文名',
  '第二中文名',
  '英文名',
  '英文名二',
  '日文名',
  '罗马字',
  '纯假名',
  '昵称',
  '简称',
  '译名',
  '其他译名',
  '其他名称',
  '其他名义',
  '英文标题',
  '原名'
]);

const MAX_ERROR_SAMPLES = 20;

export function createInfoboxStats(): InfoboxParseStats {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    empty: 0,
    sampleErrors: []
  };
}

export function parseSubjectInfobox(
  subjectId: number,
  rawInfobox: string | null | undefined,
  stats?: InfoboxParseStats,
  excludeNames?: readonly string[]
): ParsedSubjectInfobox {
  if (!rawInfobox || !rawInfobox.trim()) {
    if (stats) stats.empty += 1;
    return { ok: true, rows: [], aliases: [] };
  }

  if (stats) stats.total += 1;

  try {
    const [err, wiki] = parse2(rawInfobox);
    if (err || !wiki) {
      const reason = err ? `${err.name}: ${err.message}` : 'Unknown wiki parse failure';
      if (stats) {
        stats.failed += 1;
        if (stats.sampleErrors.length < MAX_ERROR_SAMPLES) {
          stats.sampleErrors.push({ subjectId, reason });
        }
      }
      return { ok: false, rows: [], aliases: [], error: reason };
    }

    const excluded = new Set(
      (excludeNames ?? []).map((n) => n.trim()).filter((n) => n.length > 0)
    );
    const aliasSet = new Set<string>();
    const rows: InfoboxRow[] = [];
    let ord = 0;

    for (const item of wiki.data) {
      const key = (item.key ?? '').trim();
      if (!key) continue;

      if (item.array && Array.isArray(item.values)) {
        for (const sub of item.values) {
          const val = (sub.v ?? '').trim();
          if (!val) continue;
          const subKey = sub.k ? sub.k.trim() || null : null;
          rows.push({
            subjectId,
            ord: ord++,
            key,
            subKey,
            value: val
          });
          if (ALIAS_KEYS.has(key) || (subKey !== null && ALIAS_KEYS.has(subKey))) {
            if (!excluded.has(val)) {
              aliasSet.add(val);
            }
          }
        }
      } else {
        const val = (item.value ?? '').trim();
        if (!val) continue;
        rows.push({
          subjectId,
          ord: ord++,
          key,
          subKey: null,
          value: val
        });
        if (ALIAS_KEYS.has(key) && !excluded.has(val)) {
          aliasSet.add(val);
        }
      }
    }

    if (stats) stats.succeeded += 1;
    return {
      ok: true,
      rows,
      aliases: Array.from(aliasSet)
    };
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    if (stats) {
      stats.failed += 1;
      if (stats.sampleErrors.length < MAX_ERROR_SAMPLES) {
        stats.sampleErrors.push({ subjectId, reason });
      }
    }
    return { ok: false, rows: [], aliases: [], error: reason };
  }
}
