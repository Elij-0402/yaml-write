import {
  type SplitConfidenceLevel,
  type SplitMeta,
  type SplitSelectionMode,
  type SplitStatus,
  type SplitStrategyId,
  type WinnerStrategyId,
} from './db';

// 切分质量评分 —— 纯逻辑，从 public/workers/novel-parser-worker.js 移植（双拷贝，改动需同步；
// 由 splitQuality.test.ts 的黄金向量对拍守护）。组件在手动剪/合并/撤销后用本模块即时重算 splitStatus，
// worker 仍用自己那份跑上传/重切（classic worker，静态文件，不在 webpack 图里，无法 import 本模块）。

export const SHORT_CHAPTER_CHAR_LIMIT = 120;

export interface ScoredChapter {
  title: string;
  wordCount: number;
}

export interface QualityResult {
  splitStatus: SplitStatus;
  chapterCount: number;
  avgChapterChars: number;
  maxChapterRatio: number;
  shortChapterRatio: number;
  titleHitRate: number;
  continuityScore: number | null;
  distributionScore: number;
  confidence: number;
  confidenceLevel: SplitConfidenceLevel;
  reviewReasons: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parseChineseNumber(raw: string): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const digitMap: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unitMap: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let section = 0;
  let number = 0;
  for (const char of raw) {
    if (digitMap[char] !== undefined) { number = digitMap[char]; continue; }
    const unit = unitMap[char];
    if (!unit) return null;
    if (unit === 10000) { section = (section + number) * unit; number = 0; }
    else { section += (number || 1) * unit; number = 0; }
  }
  const result = section + number;
  return result > 0 ? result : null;
}

export function extractChapterNumber(title: string): number | null {
  const en = title.match(/(?:chapter|CHAPTER|Chapter)\s*(\d{1,6})/);
  if (en?.[1]) return Number.parseInt(en[1], 10);
  const zh = title.match(/第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*[章节回卷篇幕节]/);
  if (!zh?.[1]) return null;
  return parseChineseNumber(zh[1]);
}

function computeTitleHitRate(chapters: ReadonlyArray<ScoredChapter>): number {
  if (chapters.length === 0) return 0;
  let hit = 0;
  for (const chapter of chapters) if (extractChapterNumber(chapter.title) !== null) hit += 1;
  return hit / chapters.length;
}

function computeContinuityScore(chapters: ReadonlyArray<ScoredChapter>): number | null {
  const numbers = chapters.map((chapter) => extractChapterNumber(chapter.title));
  let pairs = 0;
  let score = 0;
  for (let i = 1; i < numbers.length; i++) {
    const prev = numbers[i - 1];
    const curr = numbers[i];
    if (prev === null || curr === null) continue;
    pairs += 1;
    const diff = curr - prev;
    if (diff === 1) score += 1;
    else if (diff > 1 && diff <= 3) score += 0.6;
    else if (diff === 0) score += 0.2;
  }
  if (pairs === 0) return null;
  return clamp(score / pairs, 0, 1);
}

export function evaluateSplitQuality(
  chapters: ReadonlyArray<ScoredChapter>,
  totalChars: number
): QualityResult {
  const chapterCount = chapters.length;
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  const avgChapterChars = chapterCount > 0 ? totalWords / chapterCount : 0;
  const maxChapterChars = chapters.reduce((max, chapter) => Math.max(max, chapter.wordCount), 0);
  const maxChapterRatio = totalChars > 0 ? maxChapterChars / totalChars : 1;
  const shortCount = chapters.filter((chapter) => chapter.wordCount < SHORT_CHAPTER_CHAR_LIMIT).length;
  const shortChapterRatio = chapterCount > 0 ? shortCount / chapterCount : 1;

  const titleHitRate = computeTitleHitRate(chapters);
  const continuityScore = computeContinuityScore(chapters);

  const avgScore = avgChapterChars >= 300 && avgChapterChars <= 9000 ? 1 : avgChapterChars < 300 ? clamp(avgChapterChars / 300, 0, 1) : clamp(1 - (avgChapterChars - 9000) / 9000, 0, 1);
  const maxRatioScore = clamp(1 - (maxChapterRatio - 0.45) / 0.55, 0, 1);
  const shortRatioScore = clamp(1 - shortChapterRatio / 0.55, 0, 1);
  const countScore = totalChars < 12000 ? 0.75 : clamp(chapterCount / 8, 0, 1);

  const distributionScore = clamp(avgScore * 0.35 + maxRatioScore * 0.35 + shortRatioScore * 0.2 + countScore * 0.1, 0, 1);

  const weightedMetrics: Array<{ value: number; weight: number }> = [
    { value: distributionScore, weight: 0.45 },
    { value: titleHitRate, weight: 0.25 },
  ];
  if (typeof continuityScore === 'number') weightedMetrics.push({ value: continuityScore, weight: 0.3 });
  const totalWeight = weightedMetrics.reduce((sum, metric) => sum + metric.weight, 0) || 1;
  const confidence = clamp(weightedMetrics.reduce((sum, metric) => sum + metric.value * metric.weight, 0) / totalWeight, 0, 1);

  const confidenceLevel: SplitConfidenceLevel = confidence >= 0.8 ? 'high' : confidence >= 0.58 ? 'medium' : 'low';

  const reviewReasons: string[] = [];
  if (totalChars >= 8000 && chapterCount <= 1) reviewReasons.push('仅1章');
  if (maxChapterRatio >= 0.82) reviewReasons.push('超大章节');
  if (shortChapterRatio > 0.45) reviewReasons.push('短章过多');
  if (typeof continuityScore === 'number' && continuityScore < 0.42) reviewReasons.push('序号不连续');
  if (titleHitRate < 0.5) reviewReasons.push('标题命中低');

  const splitStatus = deriveSplitStatus(confidenceLevel);

  return { splitStatus, chapterCount, avgChapterChars, maxChapterRatio, shortChapterRatio, titleHitRate, continuityScore, distributionScore, confidence, confidenceLevel, reviewReasons };
}

export function deriveSplitStatus(level: SplitConfidenceLevel): SplitStatus {
  return level === 'low' ? 'needs_review' : 'ok';
}

export function buildSplitMeta(
  strategyId: SplitStrategyId,
  quality: QualityResult,
  engineVersion: SplitMeta['engineVersion'],
  options?: { selectionMode?: SplitSelectionMode; winnerStrategyId?: WinnerStrategyId }
): SplitMeta {
  const selectionMode: SplitSelectionMode =
    options?.selectionMode || (strategyId === 'auto_v2' ? 'auto_v2' : 'manual');
  const winnerStrategyId: WinnerStrategyId | undefined =
    options?.winnerStrategyId || (strategyId !== 'auto_v2' ? strategyId : undefined);
  return {
    strategyId,
    selectionMode,
    winnerStrategyId,
    chapterCount: quality.chapterCount,
    avgChapterChars: quality.avgChapterChars,
    maxChapterRatio: quality.maxChapterRatio,
    shortChapterRatio: quality.shortChapterRatio,
    confidence: quality.confidence,
    confidenceLevel: quality.confidenceLevel,
    reviewReasons: quality.reviewReasons,
    titleHitRate: quality.titleHitRate,
    continuityScore: quality.continuityScore,
    distributionScore: quality.distributionScore,
    engineVersion,
    updatedAt: Date.now(),
  };
}

// 手动剪/合并/撤销后即时重算：从当前章节(DB 形状，读 name)推导新的 splitStatus + splitMeta。
// 保留出处(strategyId/selectionMode/winnerStrategyId/engineVersion)，只刷新指标 —— 手动微调仍属原策略产物。
// 先按 chapterIndex 排序：continuityScore 依赖章节顺序，而 DB 的 where().toArray() 不保证按 index 返回。
export function rescoreSplit(
  chapters: ReadonlyArray<{ name: string; wordCount: number; chapterIndex?: number }>,
  priorMeta?: SplitMeta | null
): { splitStatus: SplitStatus; splitMeta: SplitMeta } {
  const ordered = [...chapters].sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0));
  const scored: ScoredChapter[] = ordered.map((c) => ({ title: c.name, wordCount: c.wordCount }));
  const totalChars = scored.reduce((sum, c) => sum + c.wordCount, 0);
  const quality = evaluateSplitQuality(scored, totalChars);
  const strategyId: SplitStrategyId = priorMeta?.strategyId ?? 'auto_v2';
  const engineVersion: SplitMeta['engineVersion'] = priorMeta?.engineVersion ?? 'v2';
  const splitMeta = buildSplitMeta(strategyId, quality, engineVersion, {
    selectionMode: priorMeta?.selectionMode,
    winnerStrategyId: priorMeta?.winnerStrategyId,
  });
  return { splitStatus: quality.splitStatus, splitMeta };
}
