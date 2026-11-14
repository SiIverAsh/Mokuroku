import { describe, expect, it } from 'vitest';
import {
  getPlatformBadgeClass,
  getScoreTierClass,
  getTagBadgeClass,
  getTagTone
} from '../src/web/lib/tag-colors.js';

describe('semantic colored tags, platforms, and score tiers', () => {
  it('assigns semantic tones to anime source, genres, and studios', () => {
    expect(getTagTone('漫画改')).toBe('cyan');
    expect(getTagTone('原创')).toBe('cyan');
    expect(getTagTone('治愈')).toBe('emerald');
    expect(getTagTone('奇幻')).toBe('indigo');
    expect(getTagTone('科幻')).toBe('indigo');
    expect(getTagTone('战斗')).toBe('amber');
    expect(getTagTone('悬疑')).toBe('purple');
    expect(getTagTone('恋爱')).toBe('rose');
    expect(getTagTone('MADHouse')).toBe('sky');
    expect(getTagTone('京阿尼')).toBe('sky');
    expect(getTagTone('2026年10月')).toBe('neutral');
  });

  it('produces deterministic non-neutral colors for long-tail tags', () => {
    const first = getTagBadgeClass('牧瀬紅莉栖');
    const second = getTagBadgeClass('牧瀬紅莉栖');
    expect(first).toBe(second);
    expect(first).not.toContain('badge-neutral');
  });

  it('distinguishes platform badges and score tiers', () => {
    expect(getPlatformBadgeClass('TV')).toContain('badge-indigo');
    expect(getPlatformBadgeClass('WEB')).toContain('badge-cyan');
    expect(getPlatformBadgeClass('剧场版')).toContain('badge-purple');
    expect(getPlatformBadgeClass('OVA')).toContain('badge-amber');

    expect(getScoreTierClass(9.1)).toContain('score-master');
    expect(getScoreTierClass(8.3)).toContain('score-great');
    expect(getScoreTierClass(7.5)).toContain('score-good');
    expect(getScoreTierClass(6.2)).toContain('score-ok');
    expect(getScoreTierClass(4.8)).toContain('score-low');
  });
});
