export const SUBJECT_TYPE_NAMES: Record<number, { key: string; cn: string }> = {
  1: { key: 'book', cn: '书籍' },
  2: { key: 'anime', cn: '动画' },
  3: { key: 'music', cn: '音乐' },
  4: { key: 'game', cn: '游戏' },
  6: { key: 'real', cn: '三次元' }
};

export const COLLECTION_TYPE_NAMES: Record<number, string> = {
  1: '想看',
  2: '看过',
  3: '在看',
  4: '搁置',
  5: '抛弃'
};

export const ANIME_CATEGORY_NAMES: Record<number, string> = {
  0: '其他',
  1: 'TV',
  2: 'OVA',
  3: '剧场版',
  5: 'WEB'
};

export function getSubjectTypeLabel(subjectType: number): string {
  return SUBJECT_TYPE_NAMES[subjectType]?.cn ?? `类型${subjectType}`;
}

export function normalizePlatformLabel(
  rawPlatform: string | number | null | undefined,
  subjectType = 2
): string {
  if (typeof rawPlatform === 'number') {
    if (subjectType === 2) {
      return ANIME_CATEGORY_NAMES[rawPlatform] ?? '';
    }
    return '';
  }
  if (!rawPlatform) return '';
  const trimmed = rawPlatform.trim();
  if (/^web$/i.test(trimmed)) return 'WEB';
  if (/^tv$/i.test(trimmed)) return 'TV';
  if (/^ova$/i.test(trimmed)) return 'OVA';
  if (/^movie$/i.test(trimmed)) return '剧场版';
  return trimmed;
}
