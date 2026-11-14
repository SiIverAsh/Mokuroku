import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldCloseDrawerOnWindowClick } from '../src/web/lib/drawer-behavior.js';
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

  it('allows scrolling main entries and switching rows while drawer is open', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/app.css'), 'utf8');
    const backdropBlock = css.match(/\.drawer-backdrop\s*\{[^}]*\}/)?.[0] ?? '';
    const bodyBlock = css.match(/\.drawer-body\s*\{[^}]*\}/)?.[0] ?? '';
    expect(backdropBlock).toContain('pointer-events: none');
    expect(bodyBlock).toContain('min-height: 0');
    expect(bodyBlock).toContain('overflow-y: auto');
    expect(bodyBlock).toContain('overscroll-behavior: contain');

    const panel = { contains: (node: unknown) => node === insideTarget };
    const insideTarget = { isConnected: true, closest: () => null };
    const rowTrigger = {
      isConnected: true,
      closest: (sel: string) => (sel === '[data-subject-trigger]' ? {} : null)
    };
    const detachedNode = { isConnected: false, closest: () => null };
    const filterSelect = {
      isConnected: true,
      closest: (sel: string) => (sel.includes('select') ? {} : null)
    };
    const blankArea = { isConnected: true, closest: () => null };

    expect(shouldCloseDrawerOnWindowClick(null, blankArea, panel)).toBe(false);
    expect(shouldCloseDrawerOnWindowClick(400602, insideTarget, panel)).toBe(false);
    expect(shouldCloseDrawerOnWindowClick(400602, rowTrigger, panel)).toBe(false);
    expect(shouldCloseDrawerOnWindowClick(400602, detachedNode, panel)).toBe(false);
    expect(shouldCloseDrawerOnWindowClick(400602, filterSelect, panel)).toBe(false);
    expect(shouldCloseDrawerOnWindowClick(400602, blankArea, panel)).toBe(true);
  });
});
