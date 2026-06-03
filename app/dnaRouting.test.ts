import { describe, it, expect } from 'vitest';
import {
  routeBySize,
  buildArcWindows,
  selectSampledWindows,
  planExtractionUnits,
  SMALL_MAX_CHARS,
  ARC_MAX_CHARS,
  type ChapterLite,
} from './dnaRouting';

const ch = (id: string, wordCount: number, name = id): ChapterLite => ({ id, name, wordCount });
// n 个等长章节，id 为 c0..c(n-1)。
const chapters = (n: number, wordCount: number) =>
  Array.from({ length: n }, (_, i) => ch(`c${i}`, wordCount, `第${i + 1}章`));

describe('routeBySize', () => {
  it('routes short books (≲18万) to single-pass direct', () => {
    expect(routeBySize(0)).toBe('direct');
    expect(routeBySize(120_000)).toBe('direct');
    expect(routeBySize(SMALL_MAX_CHARS)).toBe('direct'); // 边界含端
  });

  it('routes medium books to arc-window grouping', () => {
    expect(routeBySize(SMALL_MAX_CHARS + 1)).toBe('arc');
    expect(routeBySize(800_000)).toBe('arc');
    expect(routeBySize(ARC_MAX_CHARS)).toBe('arc'); // 边界含端
  });

  it('routes huge books (≳200万) to saturation sampling', () => {
    expect(routeBySize(ARC_MAX_CHARS + 1)).toBe('sampling');
    expect(routeBySize(5_000_000)).toBe('sampling');
  });

  it('treats non-finite word counts as direct (safe default)', () => {
    expect(routeBySize(Number.NaN)).toBe('direct');
  });
});

describe('buildArcWindows', () => {
  it('groups consecutive chapters until the char budget would be exceeded', () => {
    // 预算 1000，每章 400 → 每窗 2 章（第 3 章会超 1200>1000）。
    const units = buildArcWindows(chapters(6, 400), 1000);
    expect(units.map((u) => u.chapterIds)).toEqual([
      ['c0', 'c1'],
      ['c2', 'c3'],
      ['c4', 'c5'],
    ]);
    expect(units[0].id).toBe('c0'); // lead = 首章
  });

  it('keeps an oversized single chapter as its own window (never drops content)', () => {
    const units = buildArcWindows([ch('big', 50_000), ch('small', 100)], 24_000);
    expect(units).toHaveLength(2);
    expect(units[0].chapterIds).toEqual(['big']);
    expect(units[1].chapterIds).toEqual(['small']);
  });

  it('labels multi-chapter windows with a count', () => {
    const [u] = buildArcWindows(chapters(2, 100), 1000);
    expect(u.label).toContain('等 2 章');
  });

  it('returns one window covering everything when all fit in budget', () => {
    const units = buildArcWindows(chapters(3, 100), 100_000);
    expect(units).toHaveLength(1);
    expect(units[0].chapterIds).toEqual(['c0', 'c1', 'c2']);
  });
});

describe('selectSampledWindows', () => {
  it('returns all windows when count is within cap', () => {
    const windows = buildArcWindows(chapters(10, 100), 100); // 10 个单章窗
    expect(selectSampledWindows(windows, 48)).toHaveLength(10);
  });

  it('caps large window sets while always keeping the opening and final window', () => {
    const windows = buildArcWindows(chapters(200, 100), 100); // 200 个单章窗
    const sampled = selectSampledWindows(windows, 10);
    expect(sampled.length).toBeLessThanOrEqual(10);
    expect(sampled[0].id).toBe('c0');                 // 开篇
    expect(sampled[sampled.length - 1].id).toBe('c199'); // 尾段
  });

  it('spreads samples across the whole book (not front-loaded → 不偏科)', () => {
    const windows = buildArcWindows(chapters(200, 100), 100);
    const sampled = selectSampledWindows(windows, 5);
    const indices = sampled.map((u) => Number(u.id.slice(1)));
    // 升序且跨越后半部（中位样本应明显大于 0）。
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(indices.some((i) => i > 100)).toBe(true);
  });
});

describe('planExtractionUnits', () => {
  it('produces no chapter units for the direct route', () => {
    expect(planExtractionUnits(chapters(3, 100), 'direct')).toEqual([]);
  });

  it('covers every chapter for the arc route', () => {
    const units = planExtractionUnits(chapters(6, 400), 'arc', { budgetChars: 1000 });
    const covered = units.flatMap((u) => u.chapterIds);
    expect(covered).toHaveLength(6); // 全覆盖，无遗漏
  });

  it('bounds the sampling route to the cap', () => {
    const units = planExtractionUnits(chapters(500, 100), 'sampling', { budgetChars: 100, sampleCap: 20 });
    expect(units.length).toBeLessThanOrEqual(20);
  });
});
