import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import YAML from 'yaml';
import { PROJECT_ROOT } from '../config.js';

const COMMON_DIR = resolve(PROJECT_ROOT, 'src', 'db', 'common');

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

export interface PlatformConstant {
  subjectType: number;
  platformId: number;
  typeKey: string;
  nameCn: string;
  alias: string;
}

export interface SubjectRelationConstant {
  subjectType: number;
  relationType: number;
  nameEn: string;
  nameCn: string;
  description: string;
}

export interface SubjectStaffConstant {
  subjectType: number;
  staffId: number;
  nameEn: string;
  nameCn: string;
  nameJp: string;
}

export interface PersonRelationConstant {
  personType: string;
  relationType: number;
  nameCn: string;
  description: string;
}

export interface BangumiCommonConstants {
  platforms: PlatformConstant[];
  subjectRelations: SubjectRelationConstant[];
  subjectStaffs: SubjectStaffConstant[];
  personRelations: PersonRelationConstant[];
}

let cachedConstants: BangumiCommonConstants | null = null;

function parseYamlFile(fileName: string): Record<string, unknown> {
  const raw = readFileSync(resolve(COMMON_DIR, fileName), 'utf8');
  return YAML.parse(raw, { maxAliasCount: -1 }) as Record<string, unknown>;
}

export function loadBangumiCommonConstants(): BangumiCommonConstants {
  if (cachedConstants) return cachedConstants;

  const platformsDoc = parseYamlFile('subject_platforms.yml');
  const relationsDoc = parseYamlFile('subject_relations.yml');
  const staffsDoc = parseYamlFile('subject_staffs.yml');
  const personRelDoc = parseYamlFile('person_relations.yml');

  const platforms: PlatformConstant[] = [];
  const rawPlatforms = (platformsDoc.platforms ?? {}) as Record<string, Record<string, unknown>>;
  for (const [subjTypeKey, group] of Object.entries(rawPlatforms)) {
    const subjectType = Number(subjTypeKey);
    if (!Number.isInteger(subjectType) || !group || typeof group !== 'object') continue;
    for (const [platKey, item] of Object.entries(group)) {
      const platformId = Number(platKey);
      if (!Number.isInteger(platformId) || !item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      platforms.push({
        subjectType,
        platformId,
        typeKey: String(obj.type ?? ''),
        nameCn: String(obj.type_cn ?? obj.type ?? ''),
        alias: String(obj.alias ?? '')
      });
    }
  }

  const subjectRelations: SubjectRelationConstant[] = [];
  const rawRelations = (relationsDoc.relations ?? {}) as Record<string, Record<string, unknown>>;
  for (const [subjTypeKey, group] of Object.entries(rawRelations)) {
    const subjectType = Number(subjTypeKey);
    if (!Number.isInteger(subjectType) || !group || typeof group !== 'object') continue;
    for (const [relKey, item] of Object.entries(group)) {
      const relationType = Number(relKey);
      if (!Number.isInteger(relationType) || !item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      subjectRelations.push({
        subjectType,
        relationType,
        nameEn: String(obj.en ?? ''),
        nameCn: String(obj.cn ?? obj.en ?? ''),
        description: String(obj.desc ?? '')
      });
    }
  }

  const subjectStaffs: SubjectStaffConstant[] = [];
  const rawStaffs = (staffsDoc.staffs ?? {}) as Record<string, Record<string, unknown>>;
  for (const [subjTypeKey, group] of Object.entries(rawStaffs)) {
    const subjectType = Number(subjTypeKey);
    if (!Number.isInteger(subjectType) || !group || typeof group !== 'object') continue;
    for (const [staffKey, item] of Object.entries(group)) {
      const staffId = Number(staffKey);
      if (!Number.isInteger(staffId) || !item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      subjectStaffs.push({
        subjectType,
        staffId,
        nameEn: String(obj.en ?? ''),
        nameCn: String(obj.cn ?? obj.en ?? ''),
        nameJp: String(obj.jp ?? '')
      });
    }
  }

  const personRelations: PersonRelationConstant[] = [];
  const rawPersonRel = (personRelDoc.relations ?? {}) as Record<string, Record<string, unknown>>;
  for (const [personType, group] of Object.entries(rawPersonRel)) {
    if (!group || typeof group !== 'object') continue;
    for (const [relKey, item] of Object.entries(group)) {
      const relationType = Number(relKey);
      if (!Number.isInteger(relationType) || !item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      personRelations.push({
        personType,
        relationType,
        nameCn: String(obj.cn ?? ''),
        description: String(obj.desc ?? '')
      });
    }
  }

  cachedConstants = {
    platforms,
    subjectRelations,
    subjectStaffs,
    personRelations
  };
  return cachedConstants;
}

export function seedCommonConstants(db: Database.Database): void {
  const constants = loadBangumiCommonConstants();

  const insertSubjectType = db.prepare(
    'INSERT OR REPLACE INTO const_subject_type (id, key, name_cn) VALUES (?, ?, ?)'
  );
  const insertPlatform = db.prepare(
    'INSERT OR REPLACE INTO const_platform (subject_type, platform_id, type_key, name_cn, alias) VALUES (?, ?, ?, ?, ?)'
  );
  const insertSubjectRel = db.prepare(
    'INSERT OR REPLACE INTO const_subject_relation (subject_type, relation_type, name_en, name_cn, description) VALUES (?, ?, ?, ?, ?)'
  );
  const insertStaff = db.prepare(
    'INSERT OR REPLACE INTO const_subject_staff (subject_type, staff_id, name_en, name_cn, name_jp) VALUES (?, ?, ?, ?, ?)'
  );
  const insertPersonRel = db.prepare(
    'INSERT OR REPLACE INTO const_person_relation (person_type, relation_type, name_cn, description) VALUES (?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (const [idStr, info] of Object.entries(SUBJECT_TYPE_NAMES)) {
      insertSubjectType.run(Number(idStr), info.key, info.cn);
    }
    for (const p of constants.platforms) {
      insertPlatform.run(p.subjectType, p.platformId, p.typeKey, p.nameCn, p.alias);
    }
    for (const r of constants.subjectRelations) {
      insertSubjectRel.run(r.subjectType, r.relationType, r.nameEn, r.nameCn, r.description);
    }
    for (const s of constants.subjectStaffs) {
      insertStaff.run(s.subjectType, s.staffId, s.nameEn, s.nameCn, s.nameJp);
    }
    for (const pr of constants.personRelations) {
      insertPersonRel.run(pr.personType, pr.relationType, pr.nameCn, pr.description);
    }
  });

  tx();
}

export function getPlatformLabel(subjectType: number, platformId: number | null | undefined): string {
  if (platformId === null || platformId === undefined) return '';
  const { platforms } = loadBangumiCommonConstants();
  const hit = platforms.find(
    (p) => p.subjectType === subjectType && p.platformId === platformId
  );
  return hit?.nameCn ?? '';
}

export function getSubjectTypeLabel(subjectType: number): string {
  return SUBJECT_TYPE_NAMES[subjectType]?.cn ?? `类型${subjectType}`;
}
