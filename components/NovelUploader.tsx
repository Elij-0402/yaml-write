import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel, type SplitConfidenceLevel, type SplitMeta, type SplitStatus, type SplitStrategyId, type WinnerStrategyId } from '../app/db';
import { useAppStore } from '../app/store';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleX, Loader2, Search, Upload } from 'lucide-react';
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

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count} 字`;
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
    .replace(/[​‌‍⁠﻿]/g, '')
    .replace(/[\u0000-\b\u000b-\u001f]/g, '')
    .replace(/　/g, ' ')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
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
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const unitMap: Record<string, number> = {
    十: 10, 百: 100, 千: 1000, 万: 10000,
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
  const { selectedNovelId, setSelectedNovelId, setManageMode } = useAppStore();

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
  const chaptersQuery = useLiveQuery<Chapter[]>(() => {
    if (!selectedNovelId) return [];
    return db.chapters.where('novelId').equals(selectedNovelId).sortBy('chapterIndex');
  }, [selectedNovelId]);
  const chapters = useMemo(() => chaptersQuery || [], [chaptersQuery]);

  const activeNovel = novels.find((n) => n.id === selectedNovelId) || null;

  const derivedStats = useMemo(() => {
    if (chapters.length === 0) return null;
    const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0);
    return { chapterCount: chapters.length, avgChapterChars: totalWords / chapters.length };
  }, [chapters]);

  const needsSmartRepair = activeNovel?.splitStatus === 'needs_review';
  const readyForDna = Boolean(activeNovel && !needsSmartRepair);
  const splitMeta = activeNovel?.splitMeta;
  const reviewReasons = splitMeta?.reviewReasons || [];
  const shortChapterCount = chapters.filter((chapter) => chapter.wordCount < 500).length;
  const longChapterCount = chapters.filter((chapter) => chapter.wordCount > 12000).length;
  const splitOutputLabel = needsSmartRepair ? '章节结构待修复' : '章节结构完好，已就绪';
  const nextActionLabel = needsSmartRepair ? '执行推荐修复' : '继续进入 DNA 提炼';

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
    detecting: '编码检测中',
    reading: '原稿文本读取',
    splitting: '智能切章评估',
    saving: '项目本地入库',
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
      throw new Error('编码识别失败，请确保原稿为合规 TXT 小说');
    }
  };

  const readTextWithEncoding = async (file: File, encoding: Encoding): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const result = ev.target?.result;
        if (typeof result !== 'string') {
          reject(new Error('原稿解码结果为空'));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(new Error(`无法按 ${encoding} 解码文本`));
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
        throw new Error(`本地浏览器存储空间可能不足：可用约 ${formatSizeInMb(Math.max(0, freeBytes))}，预计需要 ${formatSizeInMb(requiredBytes)}。建议清理部分小说原稿后再试。`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('本地浏览器存储空间')) {
        throw err;
      }
    }
  };

  const readAndCleanLargeFile = async (file: File, encoding: Encoding): Promise<CleanedTextResult> => {
    setUploadStage('reading');
    setUploadStageText(`大文件模式：分块加载 (${formatSizeInMb(file.size)})`);

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
      setUploadStageText(`分块读取：${Math.min(100, Math.floor((totalRead / file.size) * 100))}%`);
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
    setUploadStageText(`文本载入中 (${formatSizeInMb(file.size)})...`);
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
      setErrorMsg('系统仅接受标准 .txt 小说文本原稿');
      return;
    }

    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      setErrorMsg(`原稿过大，工坊上限支持 ${MAX_UPLOAD_SIZE_MB}MB`);
      return;
    }

    setUploading(true);
    setUploadStage('detecting');
    setUploadStageText('编码校验中...');
    setErrorMsg(null);

    const novelId = crypto.randomUUID();
    const novelName = file.name.replace(/\.[^/.]+$/, '');

    try {
      await ensureStorageCapacity(file);
      const encoding = await detectEncoding(file);
      const { cleanedText, removedCount } = await loadAndCleanText(file, encoding);

      setUploadStage('splitting');
      setUploadStageText('智能切章计算中...');
      const splitResult = await autoSplitAsync(cleanedText, (i, n) =>
        setUploadStageText(`智能切章：策略 ${i}/${n}`),
      );
      const chaptersToSave = chaptersToDbRows(novelId, splitResult.chapters);
      const totalWords = splitResult.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

      setUploadStage('saving');
      setUploadStageText(`写入本地数据库 (${chaptersToSave.length} 章)...`);

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
      setErrorMsg(err?.message || '文件解析与切章入库失败，请重试');
    } finally {
      setUploading(false);
      setUploadStage('idle');
      setUploadStageText('');
    }
  };

  const doResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;

    if (!activeNovel.sourceTextCleaned.trim()) {
      setErrorMsg('本地文本缓存缺失，重分需重新上传 TXT 原稿');
      return;
    }

    if (strategy === 'custom') {
      if (!repairRegex.trim()) {
        setErrorMsg('请填写有效的自定义正则表达式');
        return;
      }
      const regexValidationError = validateLineRegex(repairRegex);
      if (regexValidationError) {
        setErrorMsg(regexValidationError);
        return;
      }
    }

    setRepairing(true);
    setErrorMsg(null);
    setUploadStage('splitting');
    setUploadStageText('重新划分章节中...');

    try {
      const splitResult = await runSplitWithStrategy(
        activeNovel.sourceTextCleaned,
        strategy,
        strategy === 'custom' ? repairRegex : undefined,
        (i, n) => setUploadStageText(`重新分章：策略 ${i}/${n}`),
      );
      await persistSplitResult(activeNovel.id, splitResult);
      resetChapterListView();
      pushToast('章节重切成功。', 'success');
    } catch (err: any) {
      setErrorMsg(err?.message || '章节重切失败，请检查规则');
    } finally {
      setRepairing(false);
      setUploadStage('idle');
      setUploadStageText('');
    }
  };

  const runResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;
    const chapterCount = chapters.length;
    setConfirmDialog({
      title: '确认重新章节划分',
      description: `执行此重切将完全覆写当前《${activeNovel.name}》的章节数据，并清空所有已提取的 DNA 分析进度（共 ${chapterCount} 章）。`,
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
    <div
      className="relative flex h-full min-h-0 w-full flex-col gap-5 animate-fade-in"
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".txt"
        className="hidden"
      />

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center rounded-xl border border-dashed border-white/20 bg-black/95 p-6 backdrop-blur-md transition-linear">
          <Upload className="mb-3 h-6 w-6 text-white" />
          <p className="text-sm font-semibold text-zinc-100">释手即刻导入，开启分析轨道</p>
          <p className="mt-1 text-xs text-zinc-500">工坊将自动进行原稿降噪净化，生成可校验的树状章节结构。</p>
        </div>
      )}

      {!selectedNovelId ? (
        <>
          <div className="glass-card rounded-xl p-7 border-hairline bg-surface-1">
            <p className="text-[10px] font-mono tracking-widest text-zinc-600 uppercase">导入原稿 / 项目立项</p>
            <h1 className="mt-3 text-2xl font-semibold text-zinc-100 tracking-tight">建立高可信度长篇创作项目</h1>
            <p className="mt-2.5 max-w-3xl text-xs leading-relaxed text-zinc-400">
              这里是智能流水线的物理起点。支持智能检测原稿多编码，对盗版水印、干扰小广告及特殊字符进行全自动化精密降噪净化，以生成整齐的章节列表。
            </p>

            <div className="mt-6 grid gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-hairline bg-white/[0.01] p-4">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">输入资产</p>
                <p className="mt-2 text-xs leading-relaxed text-zinc-300">本地 TXT 纯文本原稿与项目命名。</p>
              </div>
              <div className="rounded-xl border border-hairline bg-white/[0.01] p-4">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">处理阶段</p>
                <p className="mt-2 text-xs leading-relaxed text-zinc-300">自动多编码适配、水印净化、智能多策略分章。</p>
              </div>
              <div className="rounded-xl border border-hairline bg-white/[0.01] p-4">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">产出项目</p>
                <p className="mt-2 text-xs leading-relaxed text-zinc-300">完全脱敏、极度干净的结构化树状章节目录。</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-[10px] font-mono tracking-wider text-zinc-400 uppercase">准入下一步</p>
                <p className="mt-2 text-xs leading-relaxed text-zinc-200">立即进入校验台，对章节长短和连续性进行初筛。</p>
              </div>
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.35fr_0.95fr]">
            <div className="glass-card rounded-xl p-6 border-hairline bg-surface-1">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">立项入口</p>
                  <h2 className="mt-2 text-base font-semibold text-zinc-200">选择文件，开始首次导入</h2>
                  <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                    支持一键点击选择或将文件拖曳入工作区。系统处理完毕后会自动重定向至校验控制台。
                  </p>
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || repairing}
                  className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs font-medium text-zinc-200 transition-linear hover:border-white/20 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="flex items-center gap-2">
                    <Upload className="h-3.5 w-3.5" />
                    本地选择原稿 (.txt)
                  </span>
                </button>
              </div>

              <div className="mt-6 rounded-xl border border-dashed border-hairline bg-surface-2/40 px-6 py-10 text-center transition-linear hover:border-white/10">
                <Upload className="mx-auto h-5 w-5 text-zinc-500" />
                <p className="mt-4 text-xs font-medium text-zinc-300">拖拽 `.txt` 文本至此处</p>
                <p className="mt-2 text-[11px] leading-5 text-zinc-500 max-w-sm mx-auto">
                  最大支持 50MB。导入后系统会自动分析编码、过滤广告噪音并进行多策略智能分章评估。
                </p>
              </div>

              {uploading && (
                <div className="mt-5 rounded-xl border border-hairline bg-zinc-950/40 p-5">
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between text-xs text-zinc-400 font-mono">
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                        {stageLabelMap[uploadStage].toUpperCase()}
                      </span>
                      <span className="text-zinc-500">{uploadStageText}</span>
                    </div>
                    <div className="linear-loader-container rounded-full">
                      <div className="linear-loader-bar rounded-full" />
                    </div>
                    <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                      <span>STAGE_RUNNING</span>
                      <span>0{['detecting', 'reading', 'splitting', 'saving'].indexOf(uploadStage) + 1} / 04</span>
                    </div>
                  </div>
                </div>
              )}

              {!uploading && errorMsg && (
                <div className="mt-5 rounded-xl border border-rose-950/50 bg-rose-950/10 px-4 py-3 text-xs text-rose-200">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-450" />
                    <span className="leading-relaxed">{errorMsg}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-5">
              <div className="linear-card rounded-xl p-5 border-hairline bg-surface-2/40">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">数据清洗流程</p>
                <div className="mt-4 space-y-4 text-xs leading-relaxed text-zinc-400">
                  <div>
                    <p className="font-medium text-zinc-200">1. 多编码智能适配</p>
                    <p className="mt-1 text-zinc-500">精确解构 GBK, UTF-8, BIG5, UTF-16 等在野中文编码，彻底杜绝乱码风险。</p>
                  </div>
                  <div>
                    <p className="font-medium text-zinc-200">2. 自回归降噪规则</p>
                    <p className="mt-1 text-zinc-500">精准切除小说中常见的 “点击下载APP”、“笔趣阁最新域名” 等在野抓取垃圾噪音。</p>
                  </div>
                  <div>
                    <p className="font-medium text-zinc-200">3. 启发式分章评估</p>
                    <p className="mt-1 text-zinc-500">对多种中文分章正则表达式做并列拟合评估，自动筛选出最优解，提交至校验台。</p>
                  </div>
                </div>
              </div>

              <div className="linear-card rounded-xl p-5 border-hairline bg-surface-2/40">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">工坊摘要数据</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-hairline bg-white/[0.01] p-4">
                    <p className="text-[10px] font-mono text-zinc-500 uppercase">已入库作品</p>
                    <p className="mt-2 text-xl font-mono font-semibold text-zinc-300">{novels.length}</p>
                  </div>
                  <div className="rounded-xl border border-hairline bg-white/[0.01] p-4">
                    <p className="text-[10px] font-mono text-zinc-500 uppercase">待初校验数</p>
                    <p className="mt-2 text-xl font-mono font-semibold text-zinc-300">
                      {novels.filter((novel) => novel.splitStatus === 'needs_review').length}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="glass-card rounded-xl p-7 border-hairline bg-surface-1">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <p className="text-[10px] font-mono tracking-widest text-zinc-600 uppercase">章节树校验控制台</p>
                <h1 className="mt-2 text-2xl font-semibold text-zinc-100 tracking-tight">{activeNovel?.name}</h1>
                <p className="mt-2.5 text-xs leading-relaxed text-zinc-400">
                  当前处于章节划分可信度校验阶段。请审查系统输出的统计离散度指标。如果系统给出风险警告（Needs Review），建议使用右侧的重分规则进行修正。
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {needsSmartRepair ? (
                  <button
                    onClick={() => void runResplit('auto_v2')}
                    disabled={repairing}
                    className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs font-medium text-zinc-200 transition-linear hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {repairing ? '推荐章节修复中...' : '一键执行智能修复'}
                  </button>
                ) : (
                  <button
                    onClick={() => setManageMode(false)}
                    className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs font-medium text-white transition-linear hover:bg-white/[0.08]"
                  >
                    <span className="flex items-center gap-2">
                      前去 DNA 提炼
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </button>
                )}
                <button
                  onClick={() => setAdvancedRepairOpen((prev) => !prev)}
                  className="rounded-xl border border-hairline bg-white/[0.015] px-4 py-2.5 text-xs font-medium text-zinc-400 transition-linear hover:border-white/10 hover:text-zinc-200"
                >
                  {advancedRepairOpen ? '隐藏高级重划分' : '手动规则重划分'}
                </button>
              </div>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-hairline bg-white/[0.01] p-4">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">源数据输入</p>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">已载入净化文本与章节评估结构。</p>
              </div>
              <div className="rounded-xl border border-hairline bg-white/[0.01] p-4">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">校验评估项</p>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">异常短章节比例、超长篇章、标题序号递增单调性。</p>
              </div>
              <div className="rounded-xl border border-hairline bg-white/[0.01] p-4">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">评估质量状况</p>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-300">{splitOutputLabel}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-[10px] font-mono tracking-wider text-zinc-400 uppercase">建议下一步</p>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-200">{nextActionLabel}</p>
              </div>
            </div>
          </div>

          {(uploading || repairing || errorMsg) && (
            <div className={`rounded-xl border px-4 py-3.5 text-xs ${
              errorMsg
                ? 'border-rose-950/40 bg-rose-950/10 text-rose-200'
                : 'border-hairline bg-zinc-950/40 text-zinc-300'
            }`}>
              <div className="flex items-center gap-2">
                {errorMsg ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-450" />
                ) : (
                  <div className="linear-loader-container rounded-full flex-1 max-w-[200px] mr-2">
                    <div className="linear-loader-bar rounded-full" />
                  </div>
                )}
                <span className="leading-relaxed">
                  {errorMsg || (repairing ? (uploadStageText || '重切分算法评估中...') : `${stageLabelMap[uploadStage]}${uploadStageText ? `：${uploadStageText}` : ''}`)}
                </span>
              </div>
            </div>
          )}

          <div className="grid min-h-0 flex-1 gap-5 xl:grid-cols-[1.45fr_0.95fr]">
            <div className="flex min-h-0 flex-col gap-5">
              <div className="linear-card rounded-xl p-5 border-hairline bg-surface-2/40">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">离散质量测算</p>
                    <h2 className="mt-2 text-base font-semibold text-zinc-200">{splitOutputLabel}</h2>
                    <p className="mt-1 text-xs text-zinc-500">
                      总字数 {formatWordCount(activeNovel?.wordCount || 0)} · 共 {derivedStats?.chapterCount ?? chapters.length} 章 · 均章 {Math.round(derivedStats?.avgChapterChars ?? 0).toLocaleString()} 字
                    </p>
                  </div>
                  {splitMeta && (
                    <div className="flex items-center gap-1.5 rounded-full border border-hairline bg-white/[0.01] px-3 py-1 text-[10px] font-mono text-zinc-400">
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        splitMeta.confidenceLevel === 'high' ? 'bg-emerald-500' : splitMeta.confidenceLevel === 'medium' ? 'bg-amber-500' : 'bg-rose-500'
                      }`} />
                      置信度 {Math.round(splitMeta.confidence * 100)}% ({splitMeta.confidenceLevel.toUpperCase()})
                    </div>
                  )}
                </div>

                <div className="mt-5 grid gap-3 grid-cols-2 md:grid-cols-5">
                  <div className="rounded-xl border border-hairline bg-white/[0.01] p-4 text-center">
                    <p className="text-[10px] font-mono text-zinc-500 uppercase">总章节</p>
                    <p className="mt-2 text-lg font-mono font-semibold text-zinc-200">{chapters.length}</p>
                  </div>
                  <div className="rounded-xl border border-hairline bg-white/[0.01] p-4 text-center">
                    <p className="text-[10px] font-mono text-zinc-500 uppercase">均章大小</p>
                    <p className="mt-2 text-lg font-mono font-semibold text-zinc-200">{Math.round(derivedStats?.avgChapterChars ?? 0).toLocaleString()}</p>
                  </div>
                  <div className="rounded-xl border border-hairline bg-white/[0.01] p-4 text-center">
                    <p className="text-[10px] font-mono text-zinc-500 uppercase">极短章</p>
                    <p className="mt-2 text-lg font-mono font-semibold text-zinc-200">{shortChapterCount}</p>
                  </div>
                  <div className="rounded-xl border border-hairline bg-white/[0.01] p-4 text-center">
                    <p className="text-[10px] font-mono text-zinc-500 uppercase">极长章</p>
                    <p className="mt-2 text-lg font-mono font-semibold text-zinc-200">{longChapterCount}</p>
                  </div>
                  <div className="rounded-xl border border-hairline bg-white/[0.01] p-4 text-center">
                    <p className="text-[10px] font-mono text-zinc-500 uppercase">降噪字符</p>
                    <p className="mt-2 text-lg font-mono font-semibold text-zinc-200">{activeNovel?.purifiedCount?.toLocaleString() || 0}</p>
                  </div>
                </div>

                <div className="mt-5 rounded-xl border border-hairline bg-white/[0.01] p-4">
                  <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">结构异常校验原因（RISKS）</p>
                  {reviewReasons.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {reviewReasons.map((reason) => (
                        <span
                          key={reason}
                          className="flex items-center gap-1.5 rounded-full border border-rose-950/40 bg-rose-950/10 px-3 py-1 text-[11px] text-rose-300"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                          {reason}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                      项目校验指标完美拟合自单调连续性，未检出序号漏缺或极端大小异常。
                    </p>
                  )}
                </div>
              </div>

              <div className="linear-card flex min-h-0 flex-1 flex-col rounded-xl p-5 border-hairline bg-surface-2/40">
                <div className="flex flex-col gap-3 border-b border-hairline pb-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">章节树检视列表</p>
                      <h2 className="mt-1 text-sm font-semibold text-zinc-200">局部采样与结构核对</h2>
                    </div>
                  </div>

                  <div className="relative w-full">
                    <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                    <input
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setCurrentPage(1);
                      }}
                      placeholder="搜索特定的章节名称、序号、后记或楔子..."
                      className="w-full rounded-xl border border-hairline bg-zinc-950 py-2.5 pl-10 pr-4 text-xs text-zinc-100 placeholder:text-zinc-650 focus:outline-none focus:border-white/15 transition-linear"
                    />
                  </div>
                </div>

                <div className="mt-4 flex-1 overflow-y-auto pr-0.5">
                  {paginatedChapters.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-hairline bg-white/[0.01] px-6 py-12 text-center">
                      <p className="text-xs font-medium text-zinc-400">无过滤匹配结果</p>
                      <p className="mt-1 text-xs text-zinc-600">更换过滤词，以辅助检查在野章节名称的合理性。</p>
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-hairline bg-[#080808]">
                      <div className="grid grid-cols-12 gap-3 border-b border-hairline bg-white/[0.015] px-4 py-2.5 text-[9px] font-mono tracking-widest text-zinc-500 uppercase">
                        <div className="col-span-2">章节标号</div>
                        <div className="col-span-7">章节标题</div>
                        <div className="col-span-3 text-right">篇幅字数</div>
                      </div>

                      <div className="divide-y divide-white/[0.02]">
                        {paginatedChapters.map((chapter) => (
                          <div
                            key={chapter.id}
                            className="grid grid-cols-12 gap-3 px-4 py-2.5 text-xs text-zinc-400 transition-linear hover:bg-white/[0.02]"
                          >
                            <div className="col-span-2 font-mono text-zinc-500">
                              #{chapter.chapterIndex.toString().padStart(3, '0')}
                            </div>
                            <div className="col-span-7 truncate font-medium text-zinc-300" title={chapter.name}>
                              {chapter.name}
                            </div>
                            <div className="col-span-3 text-right font-mono text-zinc-500">
                              {chapter.wordCount.toLocaleString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {totalPages > 1 && (
                  <div className="mt-4 flex items-center justify-between border-t border-hairline pt-4">
                    <span className="text-[10px] font-mono text-zinc-500">
                      PAGE {safePage} / {totalPages} · TOTAL {filteredChapters.length} CHAPTERS
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                        disabled={safePage === 1}
                        className="rounded-xl border border-hairline bg-white/[0.015] px-3 py-1.5 text-[11px] text-zinc-300 transition-linear hover:border-white/10 hover:bg-white/[0.03] disabled:opacity-30"
                      >
                        PREV
                      </button>
                      <button
                        onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                        disabled={safePage === totalPages}
                        className="rounded-xl border border-hairline bg-white/[0.015] px-3 py-1.5 text-[11px] text-zinc-300 transition-linear hover:border-white/10 hover:bg-white/[0.03] disabled:opacity-30"
                      >
                        NEXT
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-5">
              <div className="glass-card rounded-xl p-5 border-hairline bg-surface-1">
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">工坊行动指引</p>
                <h3 className="mt-2.5 text-sm font-semibold text-zinc-200">{nextActionLabel}</h3>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                  {needsSmartRepair
                    ? '系统检出章节切分模型发生了离散式断层。请首先执行一键修复，以矫正数据流输入。'
                    : '本小说章节树指标完好，已锁定上游依赖。建议前去提取，点亮多维 DNA 看板。'}
                </p>

                <div className="mt-5 rounded-xl border border-hairline bg-white/[0.01] p-4 text-xs leading-relaxed text-zinc-450">
                  <p className="font-medium text-zinc-300">本阶段任务完毕后可解锁</p>
                  <p className="mt-1">
                    {needsSmartRepair
                      ? '通过最优算法重塑的章节目录，完全符合自单调性且置信度优秀。'
                      : '整本书的母题、世界观代价、角色欲望灵魂原型、叙事组织形式与精细的笔触风格指纹。'}
                  </p>
                </div>

                <div className="mt-5">
                  {needsSmartRepair ? (
                    <button
                      onClick={() => void runResplit('auto_v2')}
                      disabled={repairing}
                      className="w-full rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs font-semibold text-zinc-200 transition-linear hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {repairing ? '推荐修复重塑中...' : '一键执行智能重塑'}
                    </button>
                  ) : (
                    <button
                      onClick={() => setManageMode(false)}
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs font-semibold text-white transition-linear hover:bg-white/[0.08]"
                    >
                      <span className="flex items-center justify-center gap-2">
                        开始提炼创作 DNA
                        <ArrowRight className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  )}
                </div>
              </div>

              <div className="linear-card rounded-xl p-5 border-hairline bg-surface-2/40">
                <button
                  onClick={() => setAdvancedRepairOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between text-left"
                >
                  <div>
                    <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">专家手动划归</p>
                    <h3 className="mt-1.5 text-sm font-semibold text-zinc-200">规则专家精细化干预</h3>
                  </div>
                  <span className="text-xs text-zinc-500">{advancedRepairOpen ? '收起' : '展开'}</span>
                </button>

                <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                  如智能推荐方案与物理章节结构存在特异性出入，您可以在这里手动挑选切分策略或配置自定义正则规则。
                </p>

                {advancedRepairOpen && (
                  <div className="mt-5 space-y-4">
                    <div>
                      <label className="mb-1 block text-[10px] font-mono text-zinc-500">CHOOSE STRATEGY</label>
                      <select
                        value={repairStrategy}
                        onChange={(e) => setRepairStrategy(e.target.value as SplitStrategyId)}
                        className="w-full rounded-xl border border-hairline bg-zinc-950 px-3 py-2.5 text-xs text-zinc-200 focus:outline-none"
                      >
                        <option value="zh_strict">中文标准 (第N章/节)</option>
                        <option value="zh_extended">中文扩展 (楔子/尾声/番外)</option>
                        <option value="mixed">中英混合</option>
                        <option value="en_basic">英文标准 (Chapter)</option>
                        <option value="custom">自定义正则表达式 (Line Regex)</option>
                      </select>
                    </div>

                    <div>
                      {repairStrategy === 'custom' ? (
                        <div className="space-y-3">
                          <div>
                            <label className="mb-1 block text-[10px] font-mono text-zinc-500">LINE REGULAR EXPRESSION</label>
                            <input
                              type="text"
                              value={repairRegex}
                              onChange={(e) => setRepairRegex(e.target.value)}
                              className="w-full rounded-xl border border-hairline bg-zinc-950 px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none"
                            />
                          </div>
                          <button
                            onClick={() => void runResplit('custom')}
                            disabled={repairing}
                            className="w-full rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2 text-xs font-medium text-zinc-200 transition-linear hover:bg-white/[0.04] disabled:opacity-40"
                          >
                            {repairing ? '正规表达式重切中...' : '运行自定义正则重切'}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => void runResplit(repairStrategy)}
                          disabled={repairing}
                          className="w-full rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs font-medium text-zinc-200 transition-linear hover:bg-white/[0.04] disabled:opacity-40"
                        >
                          {repairing ? '正规策略应用中...' : '应用策略重新划归'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Toast Notifications */}
      {toast && (
        <div className="fixed top-4 right-4 z-[70] animate-fade-in">
          <div className={`px-4 py-2.5 rounded border shadow-2xl text-xs flex items-center gap-2 font-mono ${
            toast.tone === 'error'
              ? 'bg-rose-950/90 border-rose-900/60 text-rose-200'
              : toast.tone === 'success'
                ? 'bg-emerald-950/90 border-emerald-900/60 text-emerald-200'
                : 'bg-zinc-900/95 border-zinc-800 text-zinc-200'
          }`}>
            {toast.tone === 'error' ? <CircleX className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
            <span className="font-medium">{toast.message}</span>
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      {confirmDialog && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="关闭对话框"
            className="absolute inset-0 bg-black/70 backdrop-blur-xs cursor-default"
            onClick={() => setConfirmDialog(null)}
          />
          <div className="relative w-full max-w-sm rounded border border-hairline bg-[#0c0c0e] p-5 shadow-2xl z-10 animate-fade-in font-sans">
            <h4 className="text-sm font-semibold text-zinc-200">{confirmDialog.title}</h4>
            <p className="text-xs text-zinc-500 mt-2 leading-relaxed">{confirmDialog.description}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDialog(null)}
                className="px-3 py-1.5 rounded border border-hairline text-zinc-400 hover:text-zinc-200 text-xs font-medium hover:bg-zinc-900 transition-linear active-press"
              >
                取消
              </button>
              <button
                onClick={() => void confirmDialog.onConfirm()}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-linear active-press ${
                  confirmDialog.danger
                    ? 'bg-rose-900 hover:bg-rose-800 text-rose-100 border border-rose-850'
                    : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-950'
                }`}
              >
                {confirmDialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
