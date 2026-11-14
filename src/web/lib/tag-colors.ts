export type SemanticTone =
  | 'indigo'
  | 'cyan'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'purple'
  | 'sky'
  | 'teal'
  | 'blue'
  | 'green'
  | 'neutral';

const SOURCE_KEYWORDS = new Set([
  '原创',
  '漫画改',
  '漫改',
  '轻小说改',
  '轻改',
  '小说改',
  '游戏改',
  'GAL改',
  '乙女向改',
  '重制版',
  '衍生',
  '泡面番',
  '短片'
]);

const SLICE_OF_LIFE_KEYWORDS = new Set([
  '治愈',
  '日常',
  '搞笑',
  '喜剧',
  '校园',
  '青春',
  '音乐',
  '运动',
  '竞技',
  '足球',
  '篮球',
  '美食',
  '旅行',
  '公路片',
  '励志',
  '萌系',
  '轻百',
  '芳文社',
  '社团',
  '偶像',
  '职场',
  '童年',
  '吐槽',
  '吐糟',
  '沙雕'
]);

const FANTASY_SCIFI_KEYWORDS = new Set([
  '奇幻',
  '科幻',
  '异世界',
  '机战',
  '萝卜',
  '穿越',
  '转生',
  '魔法',
  '魔法少女',
  '赛博朋克',
  '太空',
  '末日',
  '废土',
  '超能力',
  '时间轮回',
  '轮回',
  '架空',
  '龙傲天',
  '蒸汽朋克'
]);

const ACTION_KEYWORDS = new Set([
  '战斗',
  '热血',
  '动作',
  '冒险',
  '武侠',
  '战争',
  '历史',
  '格斗',
  '少年',
  '王道',
  '剑戟',
  '复仇'
]);

const MYSTERY_DARK_KEYWORDS = new Set([
  '悬疑',
  '推理',
  '心理',
  '致郁',
  '黑暗',
  '惊悚',
  '恐怖',
  '智斗',
  '犯罪',
  '猎奇',
  '哲学',
  '神作',
  '群像',
  '政治',
  '反乌托邦',
  '克苏鲁',
  '民俗'
]);

const ROMANCE_DRAMA_KEYWORDS = new Set([
  '恋爱',
  '催泪',
  '感动',
  '百合',
  '纯爱',
  '后宫',
  '党争',
  '剧情',
  '家庭',
  '青梅竹马',
  '女性向',
  '耽美',
  'BL',
  '胃痛',
  '扭曲',
  '青春期',
  '卖肉',
  '里番',
  '养女儿',
  '萝莉'
]);

const STUDIO_CREATOR_PATTERNS =
  /^(京阿尼|京都动画|Kyoto\s*Animation|MADHOUSE|MADHouse|BONES|骨头社|ufotable|飞碟社|MAPPA|WIT\s*STUDIO|WITSTUDIO|霸权社|CloverWorks|A-1\s*Pictures|A-1Pictures|TRIGGER|扳机社|SHAFT|沙发套|P\.A\.WORKS|Production\s*I\.G|ProductionI\.G|SUNRISE|日升|GAINAX|吉卜力|Ghibli|J\.C\.STAFF|节操社|芳文社|动画工房|工房|WHITE\s*FOX|SILVER\s*LINK\.?|SILVERLINK\.?|Science\s*SARU|科学猴|CygamesPictures|Studio\s*Bind|Bind|8bit|LIDENFILMS|Passione|feel\.|Feel\.|C2C|ENGI|OLM|TMS|david\s*production|davidproduction|SynergySP|StudioPierrot|小丑社|手塚PRODUCTION|PolygonPictures|今敏|汤浅政明|新房昭之|庵野秀明|宫崎骏|渡边信一郎|虚渊玄|麻枝准|大河内一楼|山田尚子|斋藤圭一郎|押井守|富野由悠季|几原邦彦|细田守|新海诚|矶光雄|菅野洋子|泽野弘之|梶浦由记|牛尾宪辅|CLAMP|TYPE-MOON|Key)$/i;

const FALLBACK_TONES: readonly SemanticTone[] = [
  'sky',
  'teal',
  'indigo',
  'emerald',
  'purple',
  'amber',
  'cyan',
  'rose'
];

function hashTagToTone(tag: string): SemanticTone {
  let hash = 2166136261;
  for (let i = 0; i < tag.length; i++) {
    hash ^= tag.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return FALLBACK_TONES[(hash >>> 0) % FALLBACK_TONES.length];
}

export function getTagTone(rawTag: string): SemanticTone {
  const tag = rawTag.trim();
  if (!tag) return 'neutral';

  if (/^\d{4}(年(\d{1,2}月)?)?$/.test(tag) || /^(TV|WEB|OVA|OAD|剧场版|日本)$/i.test(tag)) {
    return 'neutral';
  }
  if (SOURCE_KEYWORDS.has(tag) || /(漫改|小说改|游戏改|原创)$/.test(tag)) {
    return 'cyan';
  }
  if (STUDIO_CREATOR_PATTERNS.test(tag)) {
    return 'sky';
  }
  if (SLICE_OF_LIFE_KEYWORDS.has(tag)) {
    return 'emerald';
  }
  if (FANTASY_SCIFI_KEYWORDS.has(tag)) {
    return 'indigo';
  }
  if (ACTION_KEYWORDS.has(tag)) {
    return 'amber';
  }
  if (MYSTERY_DARK_KEYWORDS.has(tag)) {
    return 'purple';
  }
  if (ROMANCE_DRAMA_KEYWORDS.has(tag)) {
    return 'rose';
  }

  return hashTagToTone(tag);
}

export function getTagBadgeClass(rawTag: string): string {
  return `badge badge-${getTagTone(rawTag)}`;
}

export function getPlatformBadgeClass(rawLabel: string): string {
  const label = rawLabel.trim().toUpperCase();
  if (label.includes('TV')) return 'badge badge-indigo';
  if (label.includes('WEB')) return 'badge badge-cyan';
  if (label.includes('剧场版') || label.includes('MOVIE') || label.includes('电影')) {
    return 'badge badge-purple';
  }
  if (label.includes('OVA') || label.includes('OAD')) return 'badge badge-amber';
  if (label.includes('漫画') || label.includes('小说') || label.includes('书籍')) {
    return 'badge badge-emerald';
  }
  if (label.includes('游戏')) return 'badge badge-sky';
  if (label.includes('音乐')) return 'badge badge-rose';
  return 'badge badge-teal';
}

export function getRelationBadgeClass(rawRel: string): string {
  const rel = rawRel.trim();
  if (rel === '续集') return 'badge badge-emerald';
  if (rel === '前传') return 'badge badge-indigo';
  if (rel === '改编' || rel === '主线故事' || rel === '全集') return 'badge badge-cyan';
  if (rel === '番外篇' || rel === '外传' || rel === '衍生' || rel === '总集篇') {
    return 'badge badge-amber';
  }
  if (/歌|曲|原声|广播剧/.test(rel)) return 'badge badge-rose';
  if (/世界观|演绎/.test(rel)) return 'badge badge-purple';
  return 'badge badge-sky';
}

export function getScoreTierClass(score: number | null | undefined): string {
  if (score === null || score === undefined || score <= 0) return 'score-pill score-none';
  if (score >= 8.5) return 'score-pill score-master';
  if (score >= 8.0) return 'score-pill score-great';
  if (score >= 7.0) return 'score-pill score-good';
  if (score >= 6.0) return 'score-pill score-ok';
  return 'score-pill score-low';
}
