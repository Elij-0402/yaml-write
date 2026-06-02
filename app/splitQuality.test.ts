import { describe, it, expect } from 'vitest';
import {
  deriveSplitStatus,
  evaluateSplitQuality,
  extractChapterNumber,
  buildSplitMeta,
  rescoreSplit,
} from './splitQuality';
import { type SplitMeta } from './db';

// 评分入参形状（worker 内部用 title；DB Chapter 用 name —— 适配在 rescoreSplit 里）。
const ch = (title: string, wordCount: number) => ({ title, wordCount });
const total = (chapters: ReadonlyArray<{ wordCount: number }>) =>
  chapters.reduce((sum, c) => sum + c.wordCount, 0);
// 生成 n 个标题为「第N章」、等长的整齐章节。
const cleanChapters = (n: number, wordCount: number) =>
  Array.from({ length: n }, (_, i) => ch(`第${i + 1}章 标题`, wordCount));

describe('deriveSplitStatus', () => {
  it('flags low confidence for review', () => {
    expect(deriveSplitStatus('low')).toBe('needs_review');
  });
  it('treats medium and high as ok', () => {
    expect(deriveSplitStatus('medium')).toBe('ok');
    expect(deriveSplitStatus('high')).toBe('ok');
  });
});

describe('evaluateSplitQuality', () => {
  it('scores a clean, even, well-numbered split as high / ok', () => {
    const chapters = cleanChapters(10, 3000);
    const q = evaluateSplitQuality(chapters, total(chapters));
    expect(q.confidenceLevel).toBe('high');
    expect(q.splitStatus).toBe('ok');
    expect(q.reviewReasons).toHaveLength(0);
  });

  it('flags a single giant chapter as low / needs_review with the 仅1章 reason', () => {
    const chapters = [ch('第一章 正文', 50000)];
    const q = evaluateSplitQuality(chapters, total(chapters));
    expect(q.confidenceLevel).toBe('low');
    expect(q.splitStatus).toBe('needs_review');
    expect(q.reviewReasons).toContain('仅1章');
  });

  it('flags a flood of tiny chapters as low with the 短章过多 reason', () => {
    // 微章 + 无序号标题：短章比与标题命中双双拉低置信度。
    const chapters = Array.from({ length: 20 }, () => ch('片段', 50));
    const q = evaluateSplitQuality(chapters, total(chapters));
    expect(q.splitStatus).toBe('needs_review');
    expect(q.reviewReasons).toContain('短章过多');
  });

  it('lowers continuityScore when chapter numbers are non-monotonic', () => {
    const clean = [1, 2, 3, 4, 5].map((n) => ch(`第${n}章`, 3000));
    const messy = [1, 2, 5, 3, 9].map((n) => ch(`第${n}章`, 3000));
    const cleanScore = evaluateSplitQuality(clean, total(clean)).continuityScore;
    const messyScore = evaluateSplitQuality(messy, total(messy)).continuityScore;
    expect(cleanScore).toBe(1);
    expect(messyScore).not.toBeNull();
    expect(messyScore as number).toBeLessThan(0.5);
    expect(messyScore as number).toBeLessThan(cleanScore as number);
  });
});

describe('extractChapterNumber', () => {
  it('parses Chinese, Arabic, and English chapter numbers to the same value', () => {
    expect(extractChapterNumber('第十二章')).toBe(12);
    expect(extractChapterNumber('第12章')).toBe(12);
    expect(extractChapterNumber('Chapter 12')).toBe(12);
    expect(extractChapterNumber('第二十一章 风起')).toBe(21);
  });
  it('returns null for a title with no chapter number', () => {
    expect(extractChapterNumber('无标题段落')).toBeNull();
  });
});

// DB Chapter 形状（name，非 title）——rescoreSplit 的入参。
const dbCh = (name: string, wordCount: number) => ({ name, wordCount });
const cleanDbChapters = (n: number, wordCount: number) =>
  Array.from({ length: n }, (_, i) => dbCh(`第${i + 1}章 标题`, wordCount));

describe('buildSplitMeta', () => {
  it('produces a complete, well-typed SplitMeta', () => {
    const chapters = cleanChapters(10, 3000);
    const quality = evaluateSplitQuality(chapters, total(chapters));
    const meta = buildSplitMeta('zh_strict', quality, 'v2');
    expect(meta.strategyId).toBe('zh_strict');
    expect(meta.selectionMode).toBe('manual');
    expect(meta.winnerStrategyId).toBe('zh_strict');
    expect(meta.engineVersion).toBe('v2');
    expect(meta.chapterCount).toBe(10);
    expect(meta.confidenceLevel).toBe('high');
    expect(Number.isFinite(meta.updatedAt)).toBe(true);
  });
});

describe('rescoreSplit', () => {
  it('reads the DB chapter shape (name, not title) — adapter guard', () => {
    // 漏适配 → 标题读 undefined → titleHitRate 归零 → 误判 low。整齐章节必须评为 high。
    const dbChapters = cleanDbChapters(10, 3000);
    const { splitStatus, splitMeta } = rescoreSplit(dbChapters, null);
    expect(splitStatus).toBe('ok');
    expect(splitMeta.confidenceLevel).toBe('high');
    // 与 title 形状跑出的置信度一致。
    const titleShaped = cleanChapters(10, 3000);
    const ref = evaluateSplitQuality(titleShaped, total(titleShaped));
    expect(splitMeta.confidence).toBeCloseTo(ref.confidence, 10);
  });

  it('preserves prior provenance while refreshing metrics + status', () => {
    const prior: SplitMeta = {
      strategyId: 'zh_extended',
      selectionMode: 'manual',
      winnerStrategyId: 'zh_extended',
      chapterCount: 99,
      avgChapterChars: 1,
      maxChapterRatio: 1,
      shortChapterRatio: 1,
      confidence: 0.1,
      confidenceLevel: 'low',
      reviewReasons: ['stale'],
      titleHitRate: 0,
      continuityScore: 0,
      distributionScore: 0,
      engineVersion: 'v2',
      updatedAt: 1,
    };
    const { splitMeta } = rescoreSplit(cleanDbChapters(10, 3000), prior);
    // 出处保留
    expect(splitMeta.strategyId).toBe('zh_extended');
    expect(splitMeta.selectionMode).toBe('manual');
    expect(splitMeta.winnerStrategyId).toBe('zh_extended');
    // 指标刷新（不再是 stale 值）
    expect(splitMeta.confidenceLevel).toBe('high');
    expect(splitMeta.reviewReasons).not.toContain('stale');
    expect(splitMeta.chapterCount).toBe(10);
    expect(splitMeta.updatedAt).not.toBe(1);
  });

  it('falls back to auto_v2 provenance when no prior meta', () => {
    const { splitMeta } = rescoreSplit(cleanDbChapters(10, 3000));
    expect(splitMeta.strategyId).toBe('auto_v2');
    expect(splitMeta.selectionMode).toBe('auto_v2');
    expect(splitMeta.winnerStrategyId).toBeUndefined();
  });

  it('orders chapters by chapterIndex before scoring continuity', () => {
    // DB 的 where().toArray() 不保证按 chapterIndex 排序；continuityScore 依赖顺序，必须先排。
    const shuffled = [
      { name: '第3章', wordCount: 3000, chapterIndex: 3 },
      { name: '第1章', wordCount: 3000, chapterIndex: 1 },
      { name: '第5章', wordCount: 3000, chapterIndex: 5 },
      { name: '第2章', wordCount: 3000, chapterIndex: 2 },
      { name: '第4章', wordCount: 3000, chapterIndex: 4 },
    ];
    const { splitMeta } = rescoreSplit(shuffled, null);
    expect(splitMeta.continuityScore).toBe(1);
    expect(splitMeta.confidenceLevel).toBe('high');
  });

  it('clears needs_review once the user repairs the split (the trap regression)', () => {
    // 会评低分的章节集（单一超大章）。
    const broken = [dbCh('第一章 正文', 50000)];
    expect(rescoreSplit(broken, null).splitStatus).toBe('needs_review');
    // 用户手动裁切修好后，重算应翻回 ok —— 这正是删数据陷阱要消除的行为。
    const repaired = cleanDbChapters(10, 3000);
    expect(rescoreSplit(repaired, null).splitStatus).toBe('ok');
  });
});

describe('golden vectors (pins arithmetic + worker parity)', () => {
  it('clean 10×3000 → confidence 1.0 / high / ok', () => {
    const chapters = cleanChapters(10, 3000);
    const q = evaluateSplitQuality(chapters, total(chapters));
    expect(q.confidence).toBeCloseTo(1.0, 10);
    expect(q.titleHitRate).toBeCloseTo(1.0, 10);
    expect(q.continuityScore).toBeCloseTo(1.0, 10);
    expect(q.distributionScore).toBeCloseTo(1.0, 10);
    expect(q.confidenceLevel).toBe('high');
    expect(q.splitStatus).toBe('ok');
  });
  it('single 50000-char chapter → confidence 0.49375 / low', () => {
    const chapters = [ch('第一章 正文', 50000)];
    const q = evaluateSplitQuality(chapters, total(chapters));
    expect(q.confidence).toBeCloseTo(0.49375, 5);
    expect(q.confidenceLevel).toBe('low');
  });
});
