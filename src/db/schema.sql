-- ============================================================
-- Mokuroku Archive Schema (Read-Mostly Offline Snapshot DB)
-- ============================================================
-- Note: Secondary indexes and FTS5 population are separated from
-- initial table creation in importer.ts so bulk INSERT runs first,
-- then indexes + FTS rebuild run afterward (~10x faster).

CREATE TABLE IF NOT EXISTS archive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 常量映射表（来自 bangumi/common yaml，导入时一并落库）
CREATE TABLE IF NOT EXISTS const_subject_type (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  name_cn TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS const_platform (
  subject_type INTEGER NOT NULL,
  platform_id INTEGER NOT NULL,
  type_key TEXT NOT NULL,
  name_cn TEXT NOT NULL,
  alias TEXT,
  PRIMARY KEY (subject_type, platform_id)
);

CREATE TABLE IF NOT EXISTS const_subject_relation (
  subject_type INTEGER NOT NULL,
  relation_type INTEGER NOT NULL,
  name_en TEXT,
  name_cn TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (subject_type, relation_type)
);

CREATE TABLE IF NOT EXISTS const_subject_staff (
  subject_type INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  name_en TEXT,
  name_cn TEXT NOT NULL,
  name_jp TEXT,
  PRIMARY KEY (subject_type, staff_id)
);

CREATE TABLE IF NOT EXISTS const_person_relation (
  person_type TEXT NOT NULL,
  relation_type INTEGER NOT NULL,
  name_cn TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (person_type, relation_type)
);

-- 1. 条目主表 (subject)
-- 字段覆盖全部历史扩充 (2023-07, 2024-08, 2025-04, 2025-09)
-- 缺失列允许写 NULL，不因旧快照缺列报错
CREATE TABLE IF NOT EXISTS subject (
  id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  name_cn TEXT NOT NULL DEFAULT '',
  infobox TEXT,
  platform INTEGER,
  summary TEXT,
  nsfw INTEGER NOT NULL DEFAULT 0,
  date TEXT,
  favorite TEXT,         -- JSON: { wish, done, doing, on_hold, dropped }
  series INTEGER,
  tags TEXT,             -- JSON array: [{ name, count }, ...]
  score REAL,
  score_details TEXT,    -- JSON: { "1": n, ..., "10": n }
  rank INTEGER,
  meta_tags TEXT,        -- JSON array: ["TV", "奇幻", ...]
  aliases TEXT NOT NULL DEFAULT '',      -- infobox 聚合出的别名与中文名，以空格/换行拼接供 FTS5 索引
  tags_text TEXT NOT NULL DEFAULT '',    -- tags + meta_tags 扁平化文本，供 FTS5 索引
  fav_total INTEGER NOT NULL DEFAULT 0,  -- 总收藏人数（wish+done+doing+on_hold+dropped），加速排序
  fav_doing INTEGER NOT NULL DEFAULT 0,
  fav_done INTEGER NOT NULL DEFAULT 0,
  fav_wish INTEGER NOT NULL DEFAULT 0
);

-- 2. Infobox 结构化展开表
CREATE TABLE IF NOT EXISTS subject_infobox (
  subject_id INTEGER NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  sub_key TEXT,
  value TEXT NOT NULL
);

-- 3. 章节表 (episode)
CREATE TABLE IF NOT EXISTS episode (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL,
  sort REAL,
  type INTEGER NOT NULL DEFAULT 0,
  disc INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  name_cn TEXT NOT NULL DEFAULT '',
  duration TEXT,
  airdate TEXT,
  description TEXT
);

-- 4. 角色表 (character)
CREATE TABLE IF NOT EXISTS character (
  id INTEGER PRIMARY KEY,
  role INTEGER,
  name TEXT NOT NULL DEFAULT '',
  infobox TEXT,
  summary TEXT,
  comments INTEGER,
  collects INTEGER
);

-- 5. 人物/公司表 (person)
CREATE TABLE IF NOT EXISTS person (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  type INTEGER,
  career TEXT,           -- JSON array
  infobox TEXT,
  summary TEXT,
  comments INTEGER,
  collects INTEGER
);

-- 6. 条目关联表 (subject-relations)
CREATE TABLE IF NOT EXISTS subject_relation (
  subject_id INTEGER NOT NULL,
  relation_type INTEGER NOT NULL,
  related_subject_id INTEGER NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0
);

-- 7. 条目角色关联表 (subject-characters)
CREATE TABLE IF NOT EXISTS subject_character (
  subject_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  type INTEGER NOT NULL DEFAULT 1,
  ord INTEGER NOT NULL DEFAULT 0
);

-- 8. 条目制作人员关联表 (subject-persons, 含 2025-09 appear_eps)
CREATE TABLE IF NOT EXISTS subject_person (
  subject_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  appear_eps TEXT
);

-- 9. 人物角色配音关联表 (person-characters)
CREATE TABLE IF NOT EXISTS person_character (
  person_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);

-- 10. 人物/角色关系表 (person-relations)
CREATE TABLE IF NOT EXISTS person_relation (
  person_type TEXT NOT NULL,
  person_id INTEGER NOT NULL,
  related_person_id INTEGER NOT NULL,
  relation_type INTEGER NOT NULL,
  spoiler INTEGER NOT NULL DEFAULT 0,
  ended INTEGER NOT NULL DEFAULT 0
);

-- 11. 全文检索表 (FTS5 + sqlite-better-trigram)
-- 注意：content_rowid='id' 关联 subject 表，tags 列映射 tags_text 或直接存储文本
CREATE VIRTUAL TABLE IF NOT EXISTS subject_fts USING fts5(
  name,
  name_cn,
  aliases,
  tags,
  content='subject',
  content_rowid='id',
  tokenize='better_trigram'
);
