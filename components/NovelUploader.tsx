import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel, type SplitConfidenceLevel, type SplitMeta, type SplitStatus, type SplitStrategyId, type WinnerStrategyId } from '../app/db';
import { useAppStore } from '../app/store';
import { AlertTriangle, CheckCircle2, CircleX, Loader2, Upload } from 'lucide-react';
import jschardet from 'jschardet';

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const LARGE_FILE_THRESHOLD_BYTES = 20 * 1024 * 1024;
const READ_CHUNK_SIZE_BYTES = 512 * 1024;
const SHORT_CHAPTER_CHAR_LIMIT = 120;
const DEFAULT_CUSTOM_REGEX = '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';
const MAX_CUSTOM_REGEX_LENGTH = 300;
const SPLIT_MATCH_LIMIT = 20000;
const SPLIT_TIME_BUDGET_MS = 2000;

interface ToastState {
  message: string;
  tone: 'info' | 'success' | 'error';
}

interface ConfirmDialogState {
  title: string;
  description: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
}

type BaseStrategyId = Exclude<SplitStrategyId, 'custom' | 'auto_v2'>;

const BASE_STRATEGIES: BaseStrategyId[] = ['zh_strict', 'zh_extended', 'mixed', 'en_basic'];

const STRATEGY_REGEX: Record<BaseStrategyId, string> = {
  zh_strict: '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$',
  zh_extended: '^\\s*((?:第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节]|序章|楔子|引子|前言|后记|尾声|终章|番外|完结感言)\\s*.*?)$',
  mixed: '^\\s*((?:第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*|(?:序章|楔子|引子|前言|后记|尾声|终章|番外|完结感言).*|(?:Chapter|CHAPTER|chapter)\\s*\\d+.*))$',
  en_basic: '^\\s*((?:Chapter|CHAPTER|chapter)\\s*\\d+.*?)$',
};

const V2_EXTRA_REGEX = '^\\s*((?:正文\\s*)?第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';

const REVIEW_REASON_TEXT: Record<string, string> = {
  single_chapter: '仅识别到 1 章，可能漏切',
  oversized_chapter: '存在超大章节，可能误并章',
  too_many_short: '短章节占比偏高，可能误切',
  weak_continuity: '标题编号连续性较弱',
  weak_title_match: '章节标题命中率偏低',
};

type UploadStage = 'idle' | 'detecting' | 'reading' | 'splitting' | 'saving';
type Encoding = 'UTF-8' | 'GB18030' | 'BIG5' | 'UTF-16LE' | 'UTF-16BE';

interface ParsedChapter {
  title: string;
  content: string;
  wordCount: number;
  chapterIndex: number;
}

interface CleanedTextResult {
  cleanedText: string;
  removedCount: number;
}

interface SplitQuality {
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

interface SplitCandidate {
  strategyId: SplitStrategyId;
  chapters: ParsedChapter[];
  splitStatus: SplitStatus;
  splitMeta: SplitMeta;
}

const adPatterns: RegExp[] = [
  /(https?:\/\/[^\s]+)/gi,
  /[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\.?(:\d+)?(\/\S*)*/gi,
  /【.*?整理.*?】/g,
  /【.*?制作.*?】/g,
  /（本章未完，请翻页）/g,
  /点击下一页继续阅读/g,
  /请记住本书首发域名：.*/g,
  /记住本站网址：.*/g,
  /最新章节.*?尽在.*?/g,
  /手机用户请浏览.*?阅读.*/g,
  /TXT下载.*?/gi,
  /www\..*?\.(com|net|org|cn|cc|xyz|info)/gi,
  /推荐下，.*?真心不错，值得装一个。/g,
  /【\s*广告\s*】/g,
];

const adKeywords = [
  '下载app', '最新域名', '官方微信', '关注公众号', '加入书签',
  '手机阅读', '点击下载', '投月票', '收藏本书', '安卓版', '苹果版',
  '点击下一页', '无广告', '免费阅读', '首发于', '笔趣阁',
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatSizeInMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function isWinnerStrategyId(value: unknown): value is WinnerStrategyId {
  return value === 'zh_strict'
    || value === 'zh_extended'
    || value === 'mixed'
    || value === 'en_basic'
    || value === 'custom';
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toLineRegex(pattern: string): RegExp {
  if (!pattern.trim()) {
    throw new Error('empty regex pattern');
  }
  const inputRegex = new RegExp(pattern, 'm');
  const safeFlags = inputRegex.flags.replace('g', '').replace('y', '');
  return new RegExp(inputRegex.source, safeFlags);
}

function toGlobalLineRegex(pattern: string): RegExp {
  const lineRegex = toLineRegex(pattern);
  const flags = lineRegex.flags.includes('g') ? lineRegex.flags : `${lineRegex.flags}g`;
  return new RegExp(lineRegex.source, flags);
}

function hasNestedQuantifierRisk(pattern: string): boolean {
  const nestedQuantifierRules = [
    /\((?:\\.|[^()]){0,240}(?:\*|\+|\{\d*,?\d*\})(?:\\.|[^()]){0,240}\)\s*(?:\*|\+|\{\d*,?\d*\})/,
    /\((?:\\.|[^()]){0,240}\.\*(?:\\.|[^()]){0,240}\)\s*(?:\*|\+)/,
    /\((?:\\.|[^()]){0,240}\.\+(?:\\.|[^()]){0,240}\)\s*(?:\*|\+)/,
  ];
  return nestedQuantifierRules.some((rule) => rule.test(pattern));
}

function validateLineRegex(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return '请先填写有效的自定义正则表达式。';
  }
  if (trimmed.length > MAX_CUSTOM_REGEX_LENGTH) {
    return `自定义分章正则过长（>${MAX_CUSTOM_REGEX_LENGTH} 字符），请简化后重试。`;
  }

  const blockedPatterns = [
    /\\n|\\r/,
    /\r|\n/,
    /\[\\s\\S\]/,
    /\(\?:\.\|\\n\)/,
    /\(\?s[:)]/,
    /\\A|\\Z/,
  ];

  if (blockedPatterns.some((rule) => rule.test(pattern))) {
    return '自定义分章正则需基于“单行章节标题”匹配，当前表达式包含跨行语义，请改为单行规则。';
  }

  if (hasNestedQuantifierRisk(trimmed)) {
    return '自定义分章正则包含高风险嵌套量词，可能导致浏览器卡死，请改为更简单的线性匹配规则。';
  }

  try {
    const regex = toLineRegex(trimmed);
    const match = regex.exec('');
    if (match && match[0].length === 0) {
      return '自定义分章正则不能匹配空字符串，否则会触发无限匹配。';
    }
  } catch {
    return '分章失败：自定义分章正则表达式无效';
  }

  return null;
}

function normalizeGlyphs(line: string): string {
  return line
    // strip zero-width characters and BOM
    .replace(/[​‌‍⁠﻿]/g, '')
    // strip control characters but keep tab and newline
    .replace(/[\u0000-\b\u000b-\u001f]/g, '')
    // ideographic (full-width) space -> normal space
    .replace(/　/g, ' ')
    // full-width digits/letters -> half-width (CJK punctuation left intact)
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // decode the HTML entities that show up in scraped novels
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code);
      return Number.isFinite(point) ? String.fromCharCode(point) : '';
    })
    // collapse tabs and runs of spaces
    .replace(/\t+/g, ' ')
    .replace(/ {2,}/g, ' ');
}

function cleanLine(line: string): { cleanedLine: string; removedCount: number } {
  const originalLength = line.length;
  let cleaned = normalizeGlyphs(line);

  for (const pattern of adPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  const trimmed = cleaned.trim();
  if (trimmed.length > 0) {
    const lower = trimmed.toLowerCase();
    if (trimmed.length < 35 && adKeywords.some((kw) => lower.includes(kw))) {
      cleaned = '';
    }
  }

  return {
    cleanedLine: cleaned,
    removedCount: Math.max(0, originalLength - cleaned.length),
  };
}

async function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

async function pauseToKeepUiResponsive(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function splitNovel(text: string, regexPattern: string): ParsedChapter[] {
  const normalizedText = normalizeText(text);
  const regex = toGlobalLineRegex(regexPattern);
  const positions: { title: string; index: number }[] = [];
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let matchedCount = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalizedText)) !== null) {
    matchedCount += 1;
    if (matchedCount > SPLIT_MATCH_LIMIT) {
      throw new Error(`分章失败：匹配次数超过安全阈值（${SPLIT_MATCH_LIMIT}），请简化正则。`);
    }
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
    if (elapsed > SPLIT_TIME_BUDGET_MS) {
      throw new Error(`分章失败：正则执行超时（>${SPLIT_TIME_BUDGET_MS}ms），请简化规则后重试。`);
    }

    if (match[0].length === 0) {
      regex.lastIndex = match.index + 1;
      continue;
    }

    const title = (match[1] || match[0] || '').trim();
    if (title) {
      positions.push({ title, index: match.index });
    }
  }

  if (positions.length === 0) {
    return [{
      title: '第一章 正文',
      content: normalizedText,
      wordCount: normalizedText.length,
      chapterIndex: 1,
    }];
  }

  const chapters: ParsedChapter[] = [];
  let offset = 0;

  // Capture front-matter before the first chapter title as a pseudo-chapter
  const lead = normalizedText.slice(0, positions[0].index).trim();
  if (lead.length >= SHORT_CHAPTER_CHAR_LIMIT) {
    chapters.push({ title: '前言/序', content: lead, wordCount: lead.length, chapterIndex: 1 });
    offset = 1;
  }

  for (let i = 0; i < positions.length; i++) {
    const current = positions[i];
    const next = positions[i + 1];
    const start = current.index;
    const end = next ? next.index : normalizedText.length;
    const content = normalizedText.slice(start, end).trim();
    chapters.push({
      title: current.title,
      content,
      wordCount: content.length,
      chapterIndex: i + 1 + offset,
    });
  }

  return chapters;
}

function cleanText(text: string): CleanedTextResult {
  const originalLength = text.length;
  const normalizedText = normalizeText(text);
  const lines = normalizedText.split('\n');

  const finalLines: string[] = [];
  let prevEmpty = false;
  let removedCount = 0;

  for (const rawLine of lines) {
    const { cleanedLine, removedCount: removed } = cleanLine(rawLine);
    removedCount += removed;
    const trimmed = cleanedLine.trim();
    if (trimmed === '') {
      if (!prevEmpty) {
        finalLines.push('');
      }
      prevEmpty = true;
    } else {
      finalLines.push(cleanedLine);
      prevEmpty = false;
    }
  }

  const cleanedText = finalLines.join('\n').trim();
  return {
    cleanedText,
    removedCount: Math.max(removedCount, Math.max(0, originalLength - cleanedText.length)),
  };
}

function parseChineseNumber(raw: string): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);

  const digitMap: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const unitMap: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
  };

  let section = 0;
  let number = 0;

  for (const char of raw) {
    if (digitMap[char] !== undefined) {
      number = digitMap[char];
      continue;
    }
    const unit = unitMap[char];
    if (!unit) {
      return null;
    }
    if (unit === 10000) {
      section = (section + number) * unit;
      number = 0;
    } else {
      section += (number || 1) * unit;
      number = 0;
    }
  }

  const result = section + number;
  return result > 0 ? result : null;
}

function extractChapterNumber(title: string): number | null {
  const en = title.match(/(?:chapter|CHAPTER|Chapter)\s*(\d{1,6})/);
  if (en?.[1]) {
    return Number.parseInt(en[1], 10);
  }

  const zh = title.match(/第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*[章节回卷篇幕节]/);
  if (!zh?.[1]) {
    return null;
  }
  return parseChineseNumber(zh[1]);
}

/**
 * Measures "title parseability" — the fraction of chapter titles that contain
 * a well-formed chapter number (via extractChapterNumber).  This replaced an
 * earlier first-line-equality check that was tautological (~100% always)
 * because chapter content starts with the title line.
 */
function computeTitleHitRate(chapters: ParsedChapter[]): number {
  if (chapters.length === 0) return 0;

  let hit = 0;
  for (const chapter of chapters) {
    if (extractChapterNumber(chapter.title) !== null) {
      hit += 1;
    }
  }

  return hit / chapters.length;
}

function computeContinuityScore(chapters: ParsedChapter[]): number | null {
  const numbers = chapters.map((chapter) => extractChapterNumber(chapter.title));
  let pairs = 0;
  let score = 0;

  for (let i = 1; i < numbers.length; i++) {
    const prev = numbers[i - 1];
    const curr = numbers[i];
    if (prev === null || curr === null) continue;

    pairs += 1;
    const diff = curr - prev;
    if (diff === 1) {
      score += 1;
    } else if (diff > 1 && diff <= 3) {
      score += 0.6;
    } else if (diff === 0) {
      score += 0.2;
    }
  }

  if (pairs === 0) return null;
  return clamp(score / pairs, 0, 1);
}

function evaluateSplitQuality(chapters: ParsedChapter[], totalChars: number): SplitQuality {
  const chapterCount = chapters.length;
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  const avgChapterChars = chapterCount > 0 ? totalWords / chapterCount : 0;
  const maxChapterChars = chapters.reduce((max, chapter) => Math.max(max, chapter.wordCount), 0);
  const maxChapterRatio = totalChars > 0 ? maxChapterChars / totalChars : 1;
  const shortCount = chapters.filter((chapter) => chapter.wordCount < SHORT_CHAPTER_CHAR_LIMIT).length;
  const shortChapterRatio = chapterCount > 0 ? shortCount / chapterCount : 1;

  const titleHitRate = computeTitleHitRate(chapters);
  const continuityScore = computeContinuityScore(chapters);

  const avgScore = avgChapterChars >= 300 && avgChapterChars <= 9000
    ? 1
    : avgChapterChars < 300
      ? clamp(avgChapterChars / 300, 0, 1)
      : clamp(1 - (avgChapterChars - 9000) / 9000, 0, 1);
  const maxRatioScore = clamp(1 - (maxChapterRatio - 0.45) / 0.55, 0, 1);
  const shortRatioScore = clamp(1 - shortChapterRatio / 0.55, 0, 1);
  const countScore = totalChars < 12000 ? 0.75 : clamp(chapterCount / 8, 0, 1);

  const distributionScore = clamp(
    avgScore * 0.35 + maxRatioScore * 0.35 + shortRatioScore * 0.2 + countScore * 0.1,
    0,
    1,
  );

  const weightedMetrics: Array<{ value: number; weight: number }> = [
    { value: distributionScore, weight: 0.45 },
    { value: titleHitRate, weight: 0.25 },
  ];
  if (typeof continuityScore === 'number') {
    weightedMetrics.push({ value: continuityScore, weight: 0.3 });
  }
  const totalWeight = weightedMetrics.reduce((sum, metric) => sum + metric.weight, 0) || 1;
  const confidence = clamp(
    weightedMetrics.reduce((sum, metric) => sum + metric.value * metric.weight, 0) / totalWeight,
    0,
    1,
  );

  const confidenceLevel: SplitConfidenceLevel = confidence >= 0.8
    ? 'high'
    : confidence >= 0.58
      ? 'medium'
      : 'low';

  const reviewReasons: string[] = [];
  if (totalChars >= 8000 && chapterCount <= 1) reviewReasons.push(REVIEW_REASON_TEXT.single_chapter);
  if (maxChapterRatio >= 0.82) reviewReasons.push(REVIEW_REASON_TEXT.oversized_chapter);
  if (shortChapterRatio > 0.45) reviewReasons.push(REVIEW_REASON_TEXT.too_many_short);
  if (typeof continuityScore === 'number' && continuityScore < 0.42) {
    reviewReasons.push(REVIEW_REASON_TEXT.weak_continuity);
  }
  if (titleHitRate < 0.5) reviewReasons.push(REVIEW_REASON_TEXT.weak_title_match);

  const splitStatus: SplitStatus = confidenceLevel === 'low' ? 'needs_review' : 'ok';

  return {
    splitStatus,
    chapterCount,
    avgChapterChars,
    maxChapterRatio,
    shortChapterRatio,
    titleHitRate,
    continuityScore,
    distributionScore,
    confidence,
    confidenceLevel,
    reviewReasons,
  };
}

function buildSplitMeta(
  strategyId: SplitStrategyId,
  quality: SplitQuality,
  engineVersion: 'v1' | 'v2',
  options?: { selectionMode?: SplitMeta['selectionMode']; winnerStrategyId?: WinnerStrategyId },
): SplitMeta {
  const selectionMode = options?.selectionMode || (strategyId === 'auto_v2' ? 'auto_v2' : 'manual');
  const winnerStrategyId = options?.winnerStrategyId
    || (strategyId !== 'auto_v2' && isWinnerStrategyId(strategyId) ? strategyId : undefined);
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

function runSplitWithPattern(
  text: string,
  regexPattern: string,
  strategyId: SplitStrategyId,
  engineVersion: 'v1' | 'v2',
): SplitCandidate {
  const chapters = splitNovel(text, regexPattern);
  const quality = evaluateSplitQuality(chapters, text.length);
  return {
    strategyId,
    chapters,
    splitStatus: quality.splitStatus,
    splitMeta: buildSplitMeta(strategyId, quality, engineVersion),
  };
}

function selectBetterCandidate(a: SplitCandidate, b: SplitCandidate): SplitCandidate {
  if (a.splitMeta.confidence !== b.splitMeta.confidence) {
    return a.splitMeta.confidence > b.splitMeta.confidence ? a : b;
  }
  if (a.splitMeta.chapterCount !== b.splitMeta.chapterCount) {
    return a.splitMeta.chapterCount > b.splitMeta.chapterCount ? a : b;
  }
  if (a.splitMeta.maxChapterRatio !== b.splitMeta.maxChapterRatio) {
    return a.splitMeta.maxChapterRatio < b.splitMeta.maxChapterRatio ? a : b;
  }
  return a.splitMeta.shortChapterRatio < b.splitMeta.shortChapterRatio ? a : b;
}

async function autoSplitAsync(
  text: string,
  onProgress?: (i: number, n: number) => void,
): Promise<SplitCandidate> {
  const patterns: Array<[string, SplitStrategyId]> = [
    ...BASE_STRATEGIES.map((strategy) => [STRATEGY_REGEX[strategy], strategy] as [string, SplitStrategyId]),
    [V2_EXTRA_REGEX, 'zh_extended'],
  ];

  let best: SplitCandidate | null = null;
  for (let i = 0; i < patterns.length; i++) {
    const [regex, strategyId] = patterns[i];
    const cand = runSplitWithPattern(text, regex, strategyId, 'v2');
    best = best ? selectBetterCandidate(best, cand) : cand;
    onProgress?.(i + 1, patterns.length);
    await pauseToKeepUiResponsive();
  }

  return {
    ...best!,
    strategyId: 'auto_v2',
    splitMeta: {
      ...best!.splitMeta,
      strategyId: 'auto_v2',
      selectionMode: 'auto_v2',
      winnerStrategyId: isWinnerStrategyId(best!.strategyId) ? best!.strategyId : undefined,
      engineVersion: 'v2',
      updatedAt: Date.now(),
    },
  };
}

async function runSplitWithStrategy(
  text: string,
  strategyId: SplitStrategyId,
  customRegex?: string,
  onProgress?: (i: number, n: number) => void,
): Promise<SplitCandidate> {
  if (strategyId === 'custom') {
    const pattern = customRegex?.trim() ? customRegex : DEFAULT_CUSTOM_REGEX;
    const regexValidationError = validateLineRegex(pattern);
    if (regexValidationError) {
      throw new Error(regexValidationError);
    }
    toLineRegex(pattern);
    return runSplitWithPattern(text, pattern, 'custom', 'v2');
  }
  if (strategyId === 'auto_v2') {
    return autoSplitAsync(text, onProgress);
  }
  return runSplitWithPattern(text, STRATEGY_REGEX[strategyId], strategyId, 'v2');
}

function chaptersToDbRows(novelId: string, parsedChapters: ParsedChapter[]): Chapter[] {
  return parsedChapters.map((chapter) => ({
    id: crypto.randomUUID(),
    novelId,
    chapterIndex: chapter.chapterIndex,
    name: chapter.title,
    wordCount: chapter.wordCount,
    content: chapter.content,
    status: 'unparsed',
    mapStatus: 'pending',
  }));
}

export default function NovelUploader() {
  const { selectedNovelId, setSelectedNovelId } = useAppStore();

  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadStageText, setUploadStageText] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const [advancedRepairOpen, setAdvancedRepairOpen] = useState(false);
  const [repairStrategy, setRepairStrategy] = useState<SplitStrategyId>('zh_extended');
  const [repairRegex, setRepairRegex] = useState(DEFAULT_CUSTOM_REGEX);
  const [repairing, setRepairing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const novels = useLiveQuery<Novel[]>(() => db.novels.reverse().toArray(), []) || [];
  const chapters = useLiveQuery<Chapter[]>(() => {
    if (!selectedNovelId) return [];
    return db.chapters.where('novelId').equals(selectedNovelId).sortBy('chapterIndex');
  }, [selectedNovelId]) || [];

  const activeNovel = novels.find((n) => n.id === selectedNovelId) || null;

  // Derive real stats from loaded chapters — always truthful
  const derivedStats = useMemo(() => {
    if (chapters.length === 0) return null;
    const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0);
    return { chapterCount: chapters.length, avgChapterChars: totalWords / chapters.length };
  }, [chapters]);

  const needsSmartRepair = activeNovel?.splitStatus === 'needs_review';

  const pushToast = (message: string, tone: ToastState['tone'] = 'info') => {
    setToast({ message, tone });
  };

  const resetChapterListView = () => {
    setCurrentPage(1);
    setSearchQuery('');
  };

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const stageLabelMap: Record<UploadStage, string> = {
    idle: '待开始',
    detecting: '检测编码中',
    reading: '读取文本中',
    splitting: '切章处理中',
    saving: '写入本地库中',
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) {
      await processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      await processFile(e.target.files[0]);
    }
    e.target.value = '';
  };

  const getEncodingLabel = (encoding: Encoding): string => {
    if (encoding === 'UTF-8') return 'utf-8';
    if (encoding === 'GB18030') return 'gb18030';
    if (encoding === 'BIG5') return 'big5';
    if (encoding === 'UTF-16LE') return 'utf-16le';
    return 'utf-16be';
  };

  const detectBomEncoding = (sample: Uint8Array): Encoding | null => {
    if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
      return 'UTF-8';
    }
    if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
      return 'UTF-16LE';
    }
    if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
      return 'UTF-16BE';
    }
    return null;
  };

  const guessUtf16Endianness = (sample: Uint8Array): Encoding | null => {
    const checkLength = Math.min(sample.length, 4000);
    if (checkLength < 4) return null;
    let zeroOnEven = 0;
    let zeroOnOdd = 0;
    for (let i = 0; i < checkLength; i++) {
      if (sample[i] !== 0x00) continue;
      if (i % 2 === 0) zeroOnEven += 1;
      else zeroOnOdd += 1;
    }
    const zeroRatio = (zeroOnEven + zeroOnOdd) / checkLength;
    if (zeroRatio < 0.18) return null;
    if (zeroOnOdd > zeroOnEven * 1.35) return 'UTF-16LE';
    if (zeroOnEven > zeroOnOdd * 1.35) return 'UTF-16BE';
    return null;
  };

  const getReplacementRatio = (sample: Uint8Array, label: string): number => {
    try {
      const decoded = new TextDecoder(label, { fatal: false }).decode(sample);
      if (!decoded) return 1;
      const replacementCharCount = (decoded.match(/\ufffd/g) || []).length;
      return replacementCharCount / decoded.length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const normalizeDetectedEncoding = (detected: string | undefined, sample: Uint8Array): Encoding | null => {
    if (!detected) return null;
    const normalized = detected.toUpperCase().replace(/[-_]/g, '');
    if (normalized.includes('UTF8') || normalized.includes('ASCII')) return 'UTF-8';
    if (normalized.includes('UTF16BE')) return 'UTF-16BE';
    if (normalized.includes('UTF16LE')) return 'UTF-16LE';
    if (normalized.includes('UTF16')) return guessUtf16Endianness(sample) || 'UTF-16LE';
    if (normalized.includes('BIG5')) return 'BIG5';
    if (
      normalized.includes('GB2312')
      || normalized.includes('GBK')
      || normalized.includes('GB18030')
      || normalized.includes('WINDOWS936')
    ) {
      return 'GB18030';
    }
    return null;
  };

  const detectEncoding = async (file: File): Promise<Encoding> => {
    try {
      const detectLength = Math.min(file.size, 50000);
      const detectBuffer = new Uint8Array(await readBlobAsArrayBuffer(file.slice(0, detectLength)));
      const bomEncoding = detectBomEncoding(detectBuffer);
      if (bomEncoding) return bomEncoding;

      let binaryStr = '';
      for (let i = 0; i < detectBuffer.length; i++) {
        binaryStr += String.fromCharCode(detectBuffer[i]);
      }

      let detectedEncoding: string | undefined;
      try {
        const result = jschardet.detect(binaryStr);
        detectedEncoding = result?.encoding;
      } catch {
        detectedEncoding = undefined;
      }

      let normalizedEncoding = normalizeDetectedEncoding(detectedEncoding, detectBuffer);
      if (!normalizedEncoding) {
        normalizedEncoding = guessUtf16Endianness(detectBuffer) || 'GB18030';
      }

      if (normalizedEncoding === 'UTF-8') {
        const sampleLength = Math.min(file.size, 2 * 1024 * 1024);
        const sample = new Uint8Array(await readBlobAsArrayBuffer(file.slice(0, sampleLength)));
        const utf8Ratio = getReplacementRatio(sample, 'utf-8');
        if (utf8Ratio > 0.01) {
          const gbRatio = getReplacementRatio(sample, 'gb18030');
          const big5Ratio = getReplacementRatio(sample, 'big5');
          normalizedEncoding = (big5Ratio + 0.002 < gbRatio) ? 'BIG5' : 'GB18030';
        }
      }

      return normalizedEncoding;
    } catch {
      throw new Error('编码失败：无法检测文本编码');
    }
  };

  const readTextWithEncoding = async (file: File, encoding: Encoding): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const result = ev.target?.result;
        if (typeof result !== 'string') {
          reject(new Error('编码失败：文本解码结果为空'));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(new Error(`编码失败：无法按 ${encoding} 解码文本`));
      reader.readAsText(file, getEncodingLabel(encoding));
    });
  };

  const ensureStorageCapacity = async (file: File): Promise<void> => {
    const storageManager = (navigator as Navigator & { storage?: StorageManager }).storage;
    if (!storageManager || typeof storageManager.estimate !== 'function') {
      return;
    }

    try {
      const estimate = await storageManager.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      if (!quota) return;

      const freeBytes = quota - usage;
      const requiredBytes = Math.max(file.size * 2.2, 8 * 1024 * 1024);
      if (freeBytes < requiredBytes) {
        throw new Error(`本地存储空间可能不足：可用约 ${formatSizeInMb(Math.max(0, freeBytes))}，导入预计至少需要 ${formatSizeInMb(requiredBytes)}。请清理部分小说后重试。`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('本地存储空间')) {
        throw err;
      }
    }
  };

  const readAndCleanLargeFile = async (file: File, encoding: Encoding): Promise<CleanedTextResult> => {
    setUploadStage('reading');
    setUploadStageText(`大文件模式：分块读取 (${formatSizeInMb(file.size)})`);

    const decoder = new TextDecoder(getEncodingLabel(encoding));
    const cleanedLines: string[] = [];
    let pendingFragment = '';
    let previousLineWasEmpty = false;
    let removedCount = 0;
    let originalTotalLength = 0;
    let totalRead = 0;

    const pushLine = (rawLine: string) => {
      const normalizedLine = rawLine.replace(/\r/g, '');
      const { cleanedLine, removedCount: removed } = cleanLine(normalizedLine);
      removedCount += removed;
      const trimmed = cleanedLine.trim();
      if (trimmed === '') {
        if (!previousLineWasEmpty) {
          cleanedLines.push('');
        }
        previousLineWasEmpty = true;
      } else {
        cleanedLines.push(cleanedLine);
        previousLineWasEmpty = false;
      }
    };

    for (let offset = 0; offset < file.size; offset += READ_CHUNK_SIZE_BYTES) {
      const chunk = file.slice(offset, offset + READ_CHUNK_SIZE_BYTES);
      const bytes = new Uint8Array(await readBlobAsArrayBuffer(chunk));
      totalRead += bytes.byteLength;

      const decodedText = decoder.decode(bytes, { stream: true });
      originalTotalLength += decodedText.length;
      pendingFragment += decodedText;
      const splitByLine = pendingFragment.split('\n');
      pendingFragment = splitByLine.pop() ?? '';
      splitByLine.forEach(pushLine);

      setUploadStage('reading');
      setUploadStageText(`分块读取进度：${Math.min(100, Math.floor((totalRead / file.size) * 100))}%`);
      await pauseToKeepUiResponsive();
    }

    const tailText = decoder.decode();
    originalTotalLength += tailText.length;
    pendingFragment += tailText;
    if (pendingFragment.length > 0) {
      pushLine(pendingFragment);
    }

    const cleanedText = cleanedLines.join('\n').trim();
    return {
      cleanedText,
      removedCount: Math.max(removedCount, Math.max(0, originalTotalLength - cleanedText.length)),
    };
  };

  const loadAndCleanText = async (file: File, encoding: Encoding): Promise<CleanedTextResult> => {
    if (file.size > LARGE_FILE_THRESHOLD_BYTES) {
      return readAndCleanLargeFile(file, encoding);
    }

    setUploadStage('reading');
    setUploadStageText(`正在读取 ${formatSizeInMb(file.size)} 文本...`);
    const text = await readTextWithEncoding(file, encoding);
    return cleanText(text);
  };

  const persistSplitResult = async (novelId: string, splitResult: SplitCandidate) => {
    const chaptersToSave = chaptersToDbRows(novelId, splitResult.chapters);
    const totalWords = splitResult.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(novelId).delete();
      await db.chapters.bulkAdd(chaptersToSave);
      await db.novels.update(novelId, {
        wordCount: totalWords,
        splitStatus: splitResult.splitStatus,
        splitMeta: splitResult.splitMeta,
        analysisStatus: 'idle',
        mapProgress: { total: 0, current: 0 },
        dnaCard: null,
      });
    });
  };

  const processFile = async (file: File) => {
    if (uploading || repairing) return;

    if (!file.name.toLowerCase().endsWith('.txt')) {
      setErrorMsg('只支持上传 .txt 格式的小说文本');
      return;
    }

    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      setErrorMsg(`文件过大，最大支持 ${MAX_UPLOAD_SIZE_MB}MB`);
      return;
    }

    setUploading(true);
    setUploadStage('detecting');
    setUploadStageText('正在检测编码...');
    setErrorMsg(null);

    const novelId = crypto.randomUUID();
    const novelName = file.name.replace(/\.[^/.]+$/, '');

    try {
      await ensureStorageCapacity(file);
      const encoding = await detectEncoding(file);
      const { cleanedText, removedCount } = await loadAndCleanText(file, encoding);

      setUploadStage('splitting');
      setUploadStageText('正在智能切章...');
      const splitResult = await autoSplitAsync(cleanedText, (i, n) =>
        setUploadStageText(`正在智能切章... 策略 ${i}/${n}`),
      );
      const chaptersToSave = chaptersToDbRows(novelId, splitResult.chapters);
      const totalWords = splitResult.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

      setUploadStage('saving');
      setUploadStageText(`正在入库 ${chaptersToSave.length} 章...`);

      await db.transaction('rw', db.novels, db.chapters, async () => {
        await db.novels.add({
          id: novelId,
          name: novelName,
          wordCount: totalWords,
          createdAt: Date.now(),
          purifiedCount: removedCount,
          sourceTextCleaned: cleanedText,
          splitStatus: splitResult.splitStatus,
          splitMeta: splitResult.splitMeta,
          analysisStatus: 'idle',
          mapProgress: { total: 0, current: 0 },
          dnaCard: null,
        });
        await db.chapters.bulkAdd(chaptersToSave);
      });

      setSelectedNovelId(novelId);
      resetChapterListView();
    } catch (err: any) {
      setErrorMsg(err?.message || '文件解析入库失败');
    } finally {
      setUploading(false);
      setUploadStage('idle');
      setUploadStageText('');
    }
  };

  const doResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;

    if (!activeNovel.sourceTextCleaned.trim()) {
      setErrorMsg('当前小说缺少原始文本缓存，请重新上传该小说以启用重切功能。');
      return;
    }

    if (strategy === 'custom') {
      if (!repairRegex.trim()) {
        setErrorMsg('请先填写有效的自定义正则表达式。');
        return;
      }
      const regexValidationError = validateLineRegex(repairRegex);
      if (regexValidationError) {
        setErrorMsg(regexValidationError);
        return;
      }
      try {
        toLineRegex(repairRegex);
      } catch {
        setErrorMsg('分章失败：自定义分章正则表达式无效');
        return;
      }
    }

    setRepairing(true);
    setErrorMsg(null);

    try {
      const splitResult = await runSplitWithStrategy(
        activeNovel.sourceTextCleaned,
        strategy,
        strategy === 'custom' ? repairRegex : undefined,
        (i, n) => setUploadStageText(`正在智能切章... 策略 ${i}/${n}`),
      );
      await persistSplitResult(activeNovel.id, splitResult);
      resetChapterListView();
      pushToast('重切完成。', 'success');
    } catch (err: any) {
      setErrorMsg(err?.message || '重切失败，请检查规则后重试。');
    } finally {
      setRepairing(false);
    }
  };

  const runResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;
    const chapterCount = chapters.length;
    setConfirmDialog({
      title: '确认重切',
      description: `将覆盖当前小说章节并清空已有解析结果（${chapterCount} 章）。`,
      confirmText: '确认重切',
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        await doResplit(strategy);
      },
    });
  };

  const filteredChapters = chapters.filter((chapter) =>
    chapter.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const pageSize = 12;
  const totalPages = Math.ceil(filteredChapters.length / pageSize) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const paginatedChapters = filteredChapters.slice(startIndex, startIndex + pageSize);
  return (
    <div className="flex flex-col lg:flex-row gap-6 h-full min-h-0 w-full">
      {/* Left Panel: Novel library and Upload */}
      <div className="w-full lg:w-64 flex flex-col shrink-0 gap-4">
        {/* Upload Area */}
        <div className="bg-[#121214] border border-[#1f1f23] rounded p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs uppercase font-mono tracking-wider text-zinc-500">文件导入</h4>
            <span className="text-[10px] text-zinc-650 font-mono">TXT 最大 50MB</span>
          </div>
          
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || repairing}
            className="w-full py-2 border border-dashed border-zinc-800 hover:border-zinc-700 bg-zinc-950/40 text-zinc-300 text-xs font-semibold rounded active-press transition-linear flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className="w-3.5 h-3.5 text-zinc-400" />
            选择小说文件
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".txt"
            className="hidden"
          />

          {/* Uploading Status */}
          {uploading && (
            <div className="px-3 py-2 rounded bg-zinc-950/60 border border-zinc-900 text-zinc-400 text-[11px] flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
              <span className="truncate">{stageLabelMap[uploadStage]}{uploadStageText ? `: ${uploadStageText}` : ''}</span>
            </div>
          )}

          {/* Uploading Error */}
          {!uploading && errorMsg && (
            <div className="px-3 py-2 rounded bg-rose-950/20 border border-rose-900/30 text-rose-400 text-[11px] flex items-center gap-2">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              <span className="leading-snug break-all">{errorMsg}</span>
            </div>
          )}
        </div>
      </div>

      {/* Right Panel: Main detail and chapter list */}
      <div 
        className="flex-1 bg-[#121214] border border-[#1f1f23] rounded p-6 flex flex-col min-h-0 relative select-text"
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
      >
        {/* Drag and Drop Active Overlay */}
        {dragActive && (
          <div className="absolute inset-0 bg-zinc-950/70 border-2 border-dashed border-amber-500/50 rounded z-40 flex flex-col items-center justify-center p-6 backdrop-blur-sm pointer-events-none">
            <Upload className="w-8 h-8 text-amber-500 animate-pulse mb-2" />
            <p className="text-zinc-200 text-sm font-semibold">释放以导入小说文本</p>
            <p className="text-zinc-500 text-xs mt-1">系统会自动处理编码与格式净化</p>
          </div>
        )}

        {!selectedNovelId ? (
          /* Elegant Empty Dropzone State */
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-zinc-800 rounded bg-zinc-950/10">
            <div className="p-3.5 rounded bg-zinc-900/60 border border-zinc-850 text-zinc-500 mb-4 animate-pulse">
              <Upload className="w-6 h-6" />
            </div>
            <h4 className="text-sm font-semibold text-zinc-300">导入小说文本</h4>
            <p className="text-xs text-zinc-500 mt-2 max-w-xs leading-relaxed">
              拖拽小说 .txt 文件到此区域，或在左侧点击上传。系统支持智能分章、噪声过滤与多编码识别。
            </p>
          </div>
        ) : (
          /* Novel Workspace Details */
          <div className="flex-1 flex flex-col min-h-0">
            
            {/* 1. Split summary + repair entry */}
            <div className="bg-zinc-950/50 border border-zinc-850 rounded p-4 mb-4 flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] text-zinc-500 font-mono">
                    共 {derivedStats?.chapterCount ?? chapters.length} 章节 · 均章 {Math.round(derivedStats?.avgChapterChars ?? 0)} 字
                  </p>
                  {needsSmartRepair && (
                    <p className="text-[11px] text-amber-500/90 mt-1">切分结果可能不理想，建议重新切分。</p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {needsSmartRepair && (
                    <button
                      onClick={() => void runResplit('auto_v2')}
                      disabled={repairing}
                      className="py-1.5 px-3 rounded bg-amber-500 hover:bg-amber-600 text-zinc-950 text-xs font-semibold transition-linear active-press disabled:opacity-50"
                    >
                      {repairing ? '重切处理中...' : '一键智能重切'}
                    </button>
                  )}
                  <button
                    onClick={() => setAdvancedRepairOpen((prev) => !prev)}
                    className="py-1.5 px-2.5 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs transition-linear active-press"
                  >
                    {advancedRepairOpen ? '收起修复' : '高级修复'}
                  </button>
                </div>
              </div>
            </div>

            {/* 2. Collapsible Advanced Repair Options */}
            {advancedRepairOpen && (
              <div className="bg-zinc-950/30 border border-zinc-850 rounded p-4 mb-4 flex flex-col gap-3">
                <h5 className="text-xs font-semibold text-zinc-400">手动重切规则修复</h5>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div>
                    <label className="text-[10px] text-zinc-500 block mb-1">重切策略</label>
                    <select
                      value={repairStrategy}
                      onChange={(e) => setRepairStrategy(e.target.value as SplitStrategyId)}
                      className="w-full px-2.5 py-1.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-205 text-xs focus:outline-none focus:border-zinc-700 transition-linear"
                    >
                      <option value="zh_strict">中文标准</option>
                      <option value="zh_extended">中文扩展</option>
                      <option value="mixed">中英混合</option>
                      <option value="en_basic">英文标准</option>
                      <option value="custom">自定义正则表达式</option>
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    {repairStrategy === 'custom' ? (
                      <>
                        <label className="text-[10px] text-zinc-500 block mb-1">自定义分章正则表达式</label>
                        <input
                          type="text"
                          value={repairRegex}
                          onChange={(e) => setRepairRegex(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-205 text-xs font-mono focus:outline-none focus:border-zinc-700 transition-linear"
                        />
                      </>
                    ) : (
                      <button
                        onClick={() => void runResplit(repairStrategy)}
                        disabled={repairing}
                        className="w-full md:w-auto py-1.5 px-4 rounded bg-[#1f1f23] hover:bg-[#27272a] border border-[#27272a] text-zinc-200 text-xs font-semibold transition-linear active-press disabled:opacity-50 cursor-pointer"
                      >
                        {repairing ? '重切处理中...' : '应用该策略并重切'}
                      </button>
                    )}
                  </div>

                  {repairStrategy === 'custom' && (
                    <div className="md:col-span-3 flex justify-end">
                      <button
                        onClick={() => void runResplit('custom')}
                        disabled={repairing}
                        className="py-1.5 px-4 rounded bg-[#1f1f23] hover:bg-[#27272a] border border-[#27272a] text-zinc-200 text-xs font-semibold transition-linear active-press disabled:opacity-50 cursor-pointer"
                      >
                        {repairing ? '重切处理中...' : '应用正则并重切'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 3. Toolbar: Search, Filters & Bulk Actions */}
            <div className="flex flex-col gap-3 pb-4 mb-4 border-b border-zinc-850">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-250">章节管理库</h2>
                  <p className="text-[11px] text-zinc-500 mt-0.5">当前共 {chapters.length} 章节</p>
                </div>
              </div>

          <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
            {/* Search Input */}
          </div>
        </div>

        {/* Notion-style Chapters Database List */}
        <div className="flex-1 overflow-y-auto custom-scrollbar pr-0.5 min-h-0">
          {paginatedChapters.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-16 text-zinc-600 bg-zinc-950/10 border border-dashed border-zinc-850 rounded">
              <p className="text-xs font-semibold">未找到匹配章节</p>
              <p className="text-[11px] text-zinc-500 mt-1">请尝试修改搜索词</p>
            </div>
          ) : (
            <div className="border border-zinc-850 rounded bg-zinc-950/10 overflow-hidden">
              {/* Table Header */}
              <div className="grid grid-cols-12 gap-3 px-4 py-2 bg-zinc-900/40 border-b border-zinc-850 text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-bold">
                <div className="col-span-2">序号</div>
                <div className="col-span-7">章节名称</div>
                <div className="col-span-3 text-right">字数</div>
              </div>

              {/* Table Rows */}
              <div className="divide-y divide-zinc-850/80 bg-[#121214]">
                {paginatedChapters.map((chapter) => (
                  <div
                    key={chapter.id}
                    className="grid grid-cols-12 gap-3 px-4 py-3 items-center text-xs text-zinc-400 transition-linear hover:bg-zinc-900/40"
                  >
                    {/* 1. Index */}
                    <div className="col-span-2 font-mono text-zinc-500">
                      #{chapter.chapterIndex.toString().padStart(2, '0')}
                    </div>

                    {/* 2. Name */}
                    <div className="col-span-7 truncate font-medium text-zinc-200" title={chapter.name}>
                      {chapter.name}
                    </div>

                    {/* 3. Wordcount */}
                    <div className="col-span-3 text-right font-mono text-zinc-400">
                      {chapter.wordCount.toLocaleString()} 字
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 6. Pagination Footer */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-zinc-850/80 pt-3 mt-3">
            <span className="text-[11px] text-zinc-500 font-mono">
              第 {safePage} / {totalPages} 页 · 共 {filteredChapters.length} 章节
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                disabled={safePage === 1}
                className="py-1 px-2.5 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs font-semibold disabled:opacity-30 active-press transition-linear"
              >
                上一页
              </button>
              <button
                onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                disabled={safePage === totalPages}
                className="py-1 px-2.5 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs font-semibold disabled:opacity-30 active-press transition-linear"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    )}
  </div>

  {/* Toast Notifications */}
  {toast && (
    <div className="fixed top-4 right-4 z-[70] animate-fade-in">
      <div className={`px-4 py-2.5 rounded border shadow-2xl text-xs flex items-center gap-2 font-sans ${
        toast.tone === 'error'
          ? 'bg-rose-950/90 border-rose-900/60 text-rose-200'
          : toast.tone === 'success'
            ? 'bg-emerald-950/90 border-emerald-900/60 text-emerald-200'
            : 'bg-zinc-900/95 border-zinc-800 text-zinc-200'
      }`}>
        {toast.tone === 'error' ? <CircleX className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-450" />}
        <span className="font-medium">{toast.message}</span>
      </div>
    </div>
  )}

  {/* Elegant Confirm Dialog Modal */}
  {confirmDialog && (
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="关闭对话框"
        className="absolute inset-0 bg-black/60 backdrop-blur-xs cursor-default"
        onClick={() => setConfirmDialog(null)}
      />
      <div className="relative w-full max-w-sm rounded border border-zinc-800 bg-[#121214] p-5 shadow-2xl z-10 animate-fade-in font-sans">
        <h4 className="text-sm font-bold text-zinc-200">{confirmDialog.title}</h4>
        <p className="text-xs text-zinc-400 mt-2 leading-relaxed">{confirmDialog.description}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => setConfirmDialog(null)}
            className="px-3 py-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs font-semibold hover:bg-zinc-900 transition-linear active-press"
          >
            取消
          </button>
          <button
            onClick={() => void confirmDialog.onConfirm()}
            className={`px-3 py-1.5 rounded text-xs font-semibold transition-linear active-press ${
              confirmDialog.danger
                ? 'bg-rose-600 hover:bg-rose-500 text-white border border-rose-600'
                : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-950'
            }`}
          >
            {confirmDialog.confirmText}
          </button>
        </div>
      </div>
    </div>
  )}

  {/* Right slide-out detail Drawer removed — manage view is a read-only chapter list */}

</div>
  );
}

