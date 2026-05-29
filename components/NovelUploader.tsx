import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel, type SplitConfidenceLevel, type SplitMeta, type SplitStatus, type SplitStrategyId, type WinnerStrategyId } from '../app/db';
import { useAppStore } from '../app/store';
import { AlertCircle, AlertTriangle, BookOpen, CheckCircle2, Cpu, Loader2, Pause, Play, Trash2, Upload, X, Eye, Sparkles, ChevronRight, FileText, RefreshCw, Layers, HelpCircle, Square, CircleX } from 'lucide-react';
import jschardet from 'jschardet';
import { ensureLlmConfigReady, postWithLlmConfig, readApiErrorMessage } from '../app/llmClient';

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const LARGE_FILE_THRESHOLD_BYTES = 20 * 1024 * 1024;
const READ_CHUNK_SIZE_BYTES = 512 * 1024;
const SHORT_CHAPTER_CHAR_LIMIT = 120;
const DEFAULT_CUSTOM_REGEX = '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';
const MAX_CHAPTER_CONTENT_CHARS = 30000;
const PARSE_CONCURRENCY_LIMIT = 3;
const TAB_PARSE_OWNER_KEY = 'novel-fusion-parse-owner-id';
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

interface BatchRunSnapshot {
  active: boolean;
  paused: boolean;
  total: number;
  done: number;
  error: number;
  inFlight: number;
}

interface BatchRunSummary {
  total: number;
  done: number;
  error: number;
  cancelled: boolean;
  finishedAt: number;
}

function getOrCreateTabOwnerId(): string {
  if (typeof window === 'undefined') return crypto.randomUUID();
  const existing = sessionStorage.getItem(TAB_PARSE_OWNER_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(TAB_PARSE_OWNER_KEY, created);
  return created;
}

type BaseStrategyId = Exclude<SplitStrategyId, 'custom' | 'auto_v2'>;

const BASE_STRATEGIES: BaseStrategyId[] = ['zh_strict', 'zh_extended', 'mixed', 'en_basic'];

const STRATEGY_LABELS: Record<SplitStrategyId, string> = {
  auto_v2: '自动智能 (V2)',
  zh_strict: '中文标准',
  zh_extended: '中文扩展',
  mixed: '中英混合',
  en_basic: '英文标准',
  custom: '自定义正则',
};

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

function formatMetricPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '未评估';
  }
  return `${(value * 100).toFixed(1)}%`;
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
  }));
}

function toConfidenceLabel(level: SplitConfidenceLevel): string {
  if (level === 'high') return '高置信';
  if (level === 'medium') return '中置信';
  return '低置信';
}

export default function NovelUploader() {
  const { selectedNovelId, setSelectedNovelId, selectedChapterId, setSelectedChapterId } = useAppStore();

  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadStageText, setUploadStageText] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unparsed' | 'parsing' | 'done' | 'error'>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const [advancedRepairOpen, setAdvancedRepairOpen] = useState(false);
  const [resultDetailOpen, setResultDetailOpen] = useState(false);
  const [repairStrategy, setRepairStrategy] = useState<SplitStrategyId>('zh_extended');
  const [repairRegex, setRepairRegex] = useState(DEFAULT_CUSTOM_REGEX);
  const [repairing, setRepairing] = useState(false);
  const [recomputingMeta, setRecomputingMeta] = useState(false);

  // New states for slide-out Chapter Detail review drawer
  const [activeDrawerChapterId, setActiveDrawerChapterId] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<'text' | 'analysis' | 'error'>('text');
  const [batchRun, setBatchRun] = useState<BatchRunSnapshot>({
    active: false,
    paused: false,
    total: 0,
    done: 0,
    error: 0,
    inFlight: 0,
  });
  const [lastBatchSummary, setLastBatchSummary] = useState<BatchRunSummary | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const tabOwnerIdRef = useRef<string>(getOrCreateTabOwnerId());
  const parseRunRef = useRef<{
    id: string;
    queue: Chapter[];
    index: number;
    paused: boolean;
    cancelled: boolean;
    inFlight: Set<string>;
    done: Set<string>;
    error: Set<string>;
    controllers: Map<string, AbortController>;
  } | null>(null);

  const novels = useLiveQuery<Novel[]>(() => db.novels.reverse().toArray(), []) || [];
  const chapters = useLiveQuery<Chapter[]>(() => {
    if (!selectedNovelId) return [];
    return db.chapters.where('novelId').equals(selectedNovelId).sortBy('chapterIndex');
  }, [selectedNovelId]) || [];

  const activeNovel = novels.find((n) => n.id === selectedNovelId) || null;

  const activeSplitMeta = useMemo<SplitMeta | null>(() => {
    if (!activeNovel?.splitMeta) return null;
    const meta = activeNovel.splitMeta;
    const strategyId = meta.strategyId || 'custom';
    const selectionMode = meta.selectionMode === 'auto_v2'
      ? 'auto_v2'
      : (strategyId === 'auto_v2' ? 'auto_v2' : 'manual');
    const winnerStrategyId = isWinnerStrategyId(meta.winnerStrategyId)
      ? meta.winnerStrategyId
      : (strategyId !== 'auto_v2' && isWinnerStrategyId(strategyId) ? strategyId : undefined);
    return {
      strategyId,
      selectionMode,
      winnerStrategyId,
      chapterCount: typeof meta.chapterCount === 'number' ? meta.chapterCount : 0,
      avgChapterChars: typeof meta.avgChapterChars === 'number' ? meta.avgChapterChars : 0,
      maxChapterRatio: typeof meta.maxChapterRatio === 'number' ? meta.maxChapterRatio : 1,
      shortChapterRatio: typeof meta.shortChapterRatio === 'number' ? meta.shortChapterRatio : 0,
      confidence: typeof meta.confidence === 'number' ? meta.confidence : 0.5,
      confidenceLevel: meta.confidenceLevel || (activeNovel.splitStatus === 'needs_review' ? 'low' : 'medium'),
      reviewReasons: meta.reviewReasons || [],
      titleHitRate: typeof meta.titleHitRate === 'number' ? meta.titleHitRate : null,
      continuityScore: typeof meta.continuityScore === 'number' ? meta.continuityScore : null,
      distributionScore: typeof meta.distributionScore === 'number' ? meta.distributionScore : null,
      engineVersion: meta.engineVersion || 'v1',
      updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now(),
    };
  }, [activeNovel]);

  // Derive real stats from loaded chapters — always truthful, used as fallback
  const derivedStats = useMemo(() => {
    if (chapters.length === 0) return null;
    const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0);
    return { chapterCount: chapters.length, avgChapterChars: totalWords / chapters.length };
  }, [chapters]);

  const needsSmartRepair = activeSplitMeta
    ? (activeSplitMeta.confidenceLevel === 'low' || activeSplitMeta.reviewReasons.length > 0)
    : false;

  const chapterStatusStats = useMemo(() => {
    const total = chapters.length;
    const done = chapters.filter((c) => c.status === 'done').length;
    const parsing = chapters.filter((c) => c.status === 'parsing').length;
    const error = chapters.filter((c) => c.status === 'error').length;
    const unparsed = chapters.filter((c) => c.status === 'unparsed').length;
    return { total, done, parsing, error, unparsed };
  }, [chapters]);

  const bulkStats = useMemo(() => {
    if (!batchRun.active) return null;
    const progress = batchRun.total > 0 ? Math.round((batchRun.done / batchRun.total) * 100) : 0;
    return {
      mode: 'active' as const,
      total: batchRun.total,
      done: batchRun.done,
      parsing: batchRun.inFlight,
      error: batchRun.error,
      progress,
      paused: batchRun.paused,
      cancelled: false,
    };
  }, [batchRun]);

  const batchSummaryStats = useMemo(() => {
    if (!lastBatchSummary || batchRun.active) return null;
    const resolved = Math.min(lastBatchSummary.total, lastBatchSummary.done + lastBatchSummary.error);
    return {
      mode: 'summary' as const,
      total: lastBatchSummary.total,
      done: lastBatchSummary.done,
      parsing: 0,
      error: lastBatchSummary.error,
      progress: lastBatchSummary.total > 0 ? Math.round((resolved / lastBatchSummary.total) * 100) : 100,
      paused: false,
      cancelled: lastBatchSummary.cancelled,
    };
  }, [lastBatchSummary, batchRun.active]);

  const batchPanelStats = bulkStats || batchSummaryStats;

  // Retrieve selected chapter reactive entity for the drawer details
  const drawerChapter = useMemo(() => {
    if (!activeDrawerChapterId) return null;
    return chapters.find((c) => c.id === activeDrawerChapterId) || null;
  }, [chapters, activeDrawerChapterId]);

  const pushToast = (message: string, tone: ToastState['tone'] = 'info') => {
    setToast({ message, tone });
  };

  const resetChapterListView = () => {
    setCurrentPage(1);
    setSearchQuery('');
    setStatusFilter('all');
  };

  const openSettingsPanel = () => {
    window.dispatchEvent(new Event('open-settings-panel'));
  };

  const refreshBatchSnapshot = () => {
    const run = parseRunRef.current;
    if (!run) {
      setBatchRun({
        active: false,
        paused: false,
        total: 0,
        done: 0,
        error: 0,
        inFlight: 0,
      });
      return;
    }
    const active = !run.cancelled && (run.index < run.queue.length || run.inFlight.size > 0);
    setBatchRun({
      active,
      paused: run.paused && active,
      total: run.queue.length,
      done: run.done.size,
      error: run.error.size,
      inFlight: run.inFlight.size,
    });
  };

  const ensureLlmReady = () => {
    const readiness = ensureLlmConfigReady();
    if (readiness.ok) return true;
    pushToast(readiness.message || '请先完成模型配置。', 'error');
    openSettingsPanel();
    return false;
  };

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveDrawerChapterId(null);
      }
    };
    if (activeDrawerChapterId) {
      window.addEventListener('keydown', onKeyDown);
    }
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDrawerChapterId]);

  useEffect(() => {
    const ownerId = tabOwnerIdRef.current;
    const recoverStaleParsing = async () => {
      const staleChapters = await db.chapters.where('status').equals('parsing').toArray();
      const owned = staleChapters.filter((chapter) => chapter.parsingOwnerId === ownerId);
      if (owned.length === 0) return;
      await Promise.all(owned.map((chapter) => db.chapters.update(chapter.id, {
        status: 'unparsed',
        errorMsg: '上次解析任务中断，已回退为待解析。',
        parsingSessionId: undefined,
        parsingOwnerId: undefined,
      })));
    };
    void recoverStaleParsing();

    return () => {
      const run = parseRunRef.current;
      if (!run) return;
      run.cancelled = true;
      run.controllers.forEach((controller) => controller.abort());
      parseRunRef.current = null;
    };
  }, []);

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

  const parseChapter = async (
    chapter: Chapter,
    options?: { signal?: AbortSignal; runId?: string; suppressToast?: boolean },
  ): Promise<'done' | 'error' | 'cancelled'> => {
    if (!ensureLlmReady()) return 'error';
    const contentChars = chapter.content.length;
    if (contentChars > MAX_CHAPTER_CONTENT_CHARS) {
      const tooLargeMessage = `章节「${chapter.name}」过长（${contentChars} 字），超过上限 ${MAX_CHAPTER_CONTENT_CHARS} 字。`;
      await db.chapters.update(chapter.id, {
        status: 'error',
        errorMsg: tooLargeMessage,
        parsingSessionId: undefined,
        parsingOwnerId: undefined,
      });
      if (!options?.suppressToast) pushToast(tooLargeMessage, 'error');
      return 'error';
    }

    await db.chapters.update(chapter.id, {
      status: 'parsing',
      errorMsg: undefined,
      parsingSessionId: options?.runId,
      parsingOwnerId: tabOwnerIdRef.current,
    });

    try {
      const response = await postWithLlmConfig('/api/py/parse-chapter', {
        title: chapter.name,
        content: chapter.content,
      }, {
        signal: options?.signal,
      });

      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, '解析失败'));
      }

      const analysis = await response.json();
      await db.chapters.update(chapter.id, {
        status: 'done',
        analysis,
        errorMsg: undefined,
        parsingSessionId: undefined,
        parsingOwnerId: undefined,
      });
      return 'done';
    } catch (err: any) {
      const aborted = options?.signal?.aborted || err?.name === 'AbortError';
      if (aborted) {
        await db.chapters.update(chapter.id, {
          status: 'unparsed',
          errorMsg: '已取消解析。',
          parsingSessionId: undefined,
          parsingOwnerId: undefined,
        });
        return 'cancelled';
      }

      await db.chapters.update(chapter.id, {
        status: 'error',
        errorMsg: err?.message || '大模型解析出错',
        parsingSessionId: undefined,
        parsingOwnerId: undefined,
      });
      return 'error';
    }
  };

  const cancelBatchRun = async (message = '已取消批量解析任务。') => {
    const run = parseRunRef.current;
    if (!run) return;
    const summary: BatchRunSummary = {
      total: run.queue.length,
      done: run.done.size,
      error: run.error.size,
      cancelled: true,
      finishedAt: Date.now(),
    };

    run.cancelled = true;
    run.paused = false;
    run.controllers.forEach((controller) => controller.abort());

    const parsingIds = Array.from(run.inFlight);
    if (parsingIds.length > 0) {
      await Promise.all(parsingIds.map((id) => db.chapters.update(id, {
        status: 'unparsed',
        errorMsg: '已取消解析。',
        parsingSessionId: undefined,
        parsingOwnerId: undefined,
      })));
    }

    parseRunRef.current = null;
    refreshBatchSnapshot();
    setLastBatchSummary(summary);
    pushToast(message, 'info');
  };

  const pauseBatchRun = () => {
    const run = parseRunRef.current;
    if (!run || run.cancelled) return;
    run.paused = true;
    refreshBatchSnapshot();
    pushToast('已暂停批量解析。', 'info');
  };

  const resumeBatchRun = () => {
    const run = parseRunRef.current;
    if (!run || run.cancelled) return;
    run.paused = false;
    refreshBatchSnapshot();
    pushToast('继续批量解析。', 'success');
  };

  const runBatchParsing = async (targets: Chapter[]) => {
    if (targets.length === 0) return;
    if (!ensureLlmReady()) return;
    if (parseRunRef.current) {
      pushToast('已有批量解析任务在运行。', 'info');
      return;
    }

    const runId = crypto.randomUUID();
    setLastBatchSummary(null);
    parseRunRef.current = {
      id: runId,
      queue: targets,
      index: 0,
      paused: false,
      cancelled: false,
      inFlight: new Set<string>(),
      done: new Set<string>(),
      error: new Set<string>(),
      controllers: new Map<string, AbortController>(),
    };
    refreshBatchSnapshot();

    const worker = async () => {
      while (true) {
        const run = parseRunRef.current;
        if (!run || run.id !== runId || run.cancelled) return;

        while (run.paused && !run.cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        if (run.cancelled) return;

        const idx = run.index;
        if (idx >= run.queue.length) return;
        run.index += 1;

        const chapter = run.queue[idx];
        const controller = new AbortController();
        run.controllers.set(chapter.id, controller);
        run.inFlight.add(chapter.id);
        refreshBatchSnapshot();

        const result = await parseChapter(chapter, {
          signal: controller.signal,
          runId,
          suppressToast: true,
        });

        run.controllers.delete(chapter.id);
        run.inFlight.delete(chapter.id);
        if (result === 'done') {
          run.done.add(chapter.id);
        } else if (result === 'error') {
          run.error.add(chapter.id);
        }
        refreshBatchSnapshot();
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(PARSE_CONCURRENCY_LIMIT, targets.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    const run = parseRunRef.current;
    if (!run || run.id !== runId) return;

    const hasError = run.error.size > 0;
    const summary: BatchRunSummary = {
      total: run.queue.length,
      done: run.done.size,
      error: run.error.size,
      cancelled: false,
      finishedAt: Date.now(),
    };
    parseRunRef.current = null;
    refreshBatchSnapshot();
    setLastBatchSummary(summary);
    if (hasError) {
      pushToast(`批量解析结束：成功 ${run.done.size}，失败 ${run.error.size}。`, 'info');
    } else {
      pushToast(`批量解析完成，共 ${run.done.size} 章。`, 'success');
    }
  };

  const parseAllChapters = async () => {
    const targets = chapters.filter((chapter) => chapter.status === 'unparsed' || chapter.status === 'error');
    if (targets.length === 0) {
      pushToast('没有可解析章节（待解析/失败章节为空）。', 'info');
      return;
    }

    setConfirmDialog({
      title: '开始批量解析',
      description: `准备解析 ${targets.length} 章。过程中可暂停或取消。`,
      confirmText: '开始解析',
      onConfirm: async () => {
        setConfirmDialog(null);
        await runBatchParsing(targets);
      },
    });
  };

  const retryFailedChapters = async () => {
    const failedChapters = chapters.filter((chapter) => chapter.status === 'error');
    if (failedChapters.length === 0) {
      pushToast('当前没有解析失败章节。', 'info');
      return;
    }

    setConfirmDialog({
      title: '重试失败章节',
      description: `准备重试 ${failedChapters.length} 个失败章节。`,
      confirmText: '开始重试',
      onConfirm: async () => {
        setConfirmDialog(null);
        await runBatchParsing(failedChapters);
      },
    });
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
      });
    });

    if (chaptersToSave[0]) {
      setSelectedChapterId(chaptersToSave[0].id);
    }
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
        });
        await db.chapters.bulkAdd(chaptersToSave);
      });

      setSelectedNovelId(novelId);
      resetChapterListView();
      if (chaptersToSave[0]) {
        setSelectedChapterId(chaptersToSave[0].id);
        setActiveDrawerChapterId(chaptersToSave[0].id);
      }
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

  /** Rebuild splitMeta from stored chapters — non-destructive (no chapter deletion). */
  const recomputeSplitMetaFromChapters = async () => {
    if (!activeNovel || chapters.length === 0 || recomputingMeta) return;
    setRecomputingMeta(true);
    setErrorMsg(null);

    try {
      const parsed: ParsedChapter[] = chapters.map((c) => ({
        title: c.name,
        content: c.content,
        wordCount: c.wordCount,
        chapterIndex: c.chapterIndex,
      }));
      const totalChars = parsed.reduce((s, c) => s + c.wordCount, 0);
      const quality = evaluateSplitQuality(parsed, totalChars);
      const preservedStrategyId = activeNovel.splitMeta?.strategyId ?? 'custom';
      const preservedSelectionMode = activeNovel.splitMeta?.selectionMode === 'auto_v2'
        ? 'auto_v2'
        : (preservedStrategyId === 'auto_v2' ? 'auto_v2' : 'manual');
      const preservedWinnerStrategyId = isWinnerStrategyId(activeNovel.splitMeta?.winnerStrategyId)
        ? activeNovel.splitMeta?.winnerStrategyId
        : (preservedStrategyId !== 'auto_v2' && isWinnerStrategyId(preservedStrategyId) ? preservedStrategyId : undefined);
      const meta = buildSplitMeta(
        preservedStrategyId,
        quality,
        activeNovel.splitMeta?.engineVersion || 'v1',
        {
          selectionMode: preservedSelectionMode,
          winnerStrategyId: preservedWinnerStrategyId,
        },
      );
      await db.novels.update(activeNovel.id, {
        splitStatus: quality.splitStatus,
        splitMeta: meta,
      });
    } catch (err: any) {
      setErrorMsg(err?.message || '重新评估失败');
    } finally {
      setRecomputingMeta(false);
    }
  };

  const deleteNovel = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const chapterCount = await db.chapters.where('novelId').equals(id).count();
    setConfirmDialog({
      title: '删除小说',
      description: `将删除该小说及 ${chapterCount} 章解析结果。此操作不可撤销。`,
      confirmText: '确认删除',
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        const run = parseRunRef.current;
        const runTouchesNovel = !!run && run.queue.some((chapter) => chapter.novelId === id);
        if (runTouchesNovel) {
          await cancelBatchRun('已取消与该小说相关的批量解析任务。');
        }
        await db.transaction('rw', db.novels, db.chapters, async () => {
          await db.chapters.where('novelId').equals(id).delete();
          await db.novels.delete(id);
        });

        if (selectedNovelId === id) {
          setSelectedNovelId(null);
          setSelectedChapterId(null);
          setActiveDrawerChapterId(null);
          resetChapterListView();
        }
        pushToast('小说已删除。', 'success');
      },
    });
  };

  const filteredChapters = chapters.filter((chapter) => {
    const matchesSearch = chapter.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || chapter.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const pageSize = 12;
  const totalPages = Math.ceil(filteredChapters.length / pageSize) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const paginatedChapters = filteredChapters.slice(startIndex, startIndex + pageSize);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-auto lg:h-[calc(100vh-12rem)] min-h-0">
      <div className="lg:col-span-1 bg-zinc-900/20 border border-zinc-800/70 rounded-2xl p-4 flex flex-col min-h-0">
        <h3 className="text-xs font-semibold text-zinc-400 mb-3 uppercase tracking-wider">导入</h3>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || repairing}
          className="w-full py-2.5 mb-2 rounded-xl border border-dashed border-zinc-700 hover:border-zinc-500 bg-zinc-900/40 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          <Upload className="w-4 h-4" />
          导入小说 (.txt, 最大 {MAX_UPLOAD_SIZE_MB}MB)
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".txt"
          className="hidden"
        />

        {uploading && (
          <div className="mb-2 px-3 py-2 rounded-lg bg-zinc-900/60 border border-zinc-800 text-zinc-300 text-[11px] flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
            <span>{stageLabelMap[uploadStage]}{uploadStageText ? `：${uploadStageText}` : ''}</span>
          </div>
        )}

        {!uploading && errorMsg && (
          <div className="mb-2 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[11px] flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="pt-2 border-t border-zinc-800/80 mt-2 mb-2">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">小说列表</p>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {novels.length === 0 ? (
            <div className="text-center py-8 text-zinc-600 text-xs">暂无小说，请先导入</div>
          ) : (
            novels.map((novel) => (
              <div
                key={novel.id}
                onClick={() => {
                  setSelectedNovelId(novel.id);
                  resetChapterListView();
                  setActiveDrawerChapterId(null);
                }}
                className={`group p-3 rounded-xl border transition-colors cursor-pointer flex items-center justify-between ${
                  selectedNovelId === novel.id
                    ? 'bg-zinc-800/60 border-zinc-700 text-zinc-100'
                    : 'bg-zinc-950/20 border-zinc-900/80 hover:border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <BookOpen className={`w-4 h-4 flex-shrink-0 ${selectedNovelId === novel.id ? 'text-zinc-300' : 'text-zinc-500'}`} />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{novel.name}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{(novel.wordCount / 10000).toFixed(1)}万字</p>
                  </div>
                </div>
                <button
                  onClick={(e) => deleteNovel(novel.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-rose-400 rounded transition-opacity"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div
        className="lg:col-span-3 bg-zinc-900/20 border border-zinc-800/70 rounded-2xl p-5 flex flex-col min-h-0 relative overflow-hidden"
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
      >
        {!selectedNovelId ? (
          <div
            className={`flex-1 border border-dashed rounded-2xl flex flex-col items-center justify-center p-8 transition-colors ${
              dragActive ? 'border-zinc-500 bg-zinc-900/25' : 'border-zinc-800 bg-zinc-950/20'
            }`}
          >
            <div className="p-3 rounded-full bg-zinc-900/60 border border-zinc-800 text-zinc-400 mb-3">
              <Upload className="w-7 h-7" />
            </div>
            <h4 className="text-base font-semibold text-zinc-200">拖拽上传小说文本</h4>
            <p className="text-xs text-zinc-500 mt-2 text-center max-w-sm">
              系统会自动识别编码、净化噪声并智能切章。
            </p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="border border-zinc-800 rounded-xl px-4 py-3 bg-zinc-950/30">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200">
                    分章完成 · {activeSplitMeta ? toConfidenceLabel(activeSplitMeta.confidenceLevel) : '历史导入'} · {activeSplitMeta?.chapterCount ?? derivedStats?.chapterCount ?? chapters.length}章 · 均章 {Math.round(activeSplitMeta?.avgChapterChars ?? derivedStats?.avgChapterChars ?? 0)}字
                  </p>
                  {activeSplitMeta ? (
                    <p className="text-[11px] text-zinc-500 mt-1">
                      引擎 {activeSplitMeta.engineVersion === 'v2' ? 'V2' : 'V1'}
                      {' · '}
                      选择方式 {activeSplitMeta.selectionMode === 'auto_v2' ? '自动智能(V2)' : '手动'}
                      {' · '}
                      命中策略 {activeSplitMeta.winnerStrategyId ? STRATEGY_LABELS[activeSplitMeta.winnerStrategyId] : '未知'}
                    </p>
                  ) : (
                    <p className="text-[11px] text-zinc-500 mt-1">历史导入 · 未评估</p>
                  )}
                </div>

                <div className="flex flex-col items-end gap-1">
                  {needsSmartRepair && (
                    <>
                      <button
                        onClick={() => void runResplit('auto_v2')}
                        disabled={repairing}
                        className="py-2 px-3 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-900 text-xs font-semibold disabled:opacity-50"
                      >
                        {repairing ? '重切处理中...' : '建议智能重切'}
                      </button>
                      <button
                        onClick={() => setAdvancedRepairOpen((prev) => !prev)}
                        className="text-[11px] text-zinc-500 hover:text-zinc-300"
                      >
                        手动规则
                      </button>
                    </>
                  )}
                  {!activeSplitMeta && (
                    <button
                      onClick={() => void recomputeSplitMetaFromChapters()}
                      disabled={recomputingMeta}
                      className="py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5"
                    >
                      <RefreshCw className={`w-3 h-3 ${recomputingMeta ? 'animate-spin' : ''}`} />
                      {recomputingMeta ? '评估中...' : '重新评估'}
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={() => setResultDetailOpen((prev) => !prev)}
                  className="text-[11px] text-zinc-500 hover:text-zinc-300"
                >
                  {resultDetailOpen ? '收起详情' : '查看详情'}
                </button>
                {activeNovel && activeNovel.purifiedCount !== undefined && activeNovel.purifiedCount > 0 && (
                  <span className="text-[11px] text-zinc-500">净化噪声字符 {activeNovel.purifiedCount}</span>
                )}
              </div>

              {resultDetailOpen && activeSplitMeta && (
                <div className="mt-3 pt-3 border-t border-zinc-800 text-xs text-zinc-400 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>最大章占比 {(activeSplitMeta.maxChapterRatio * 100).toFixed(1)}%</div>
                  <div>短章占比 {(activeSplitMeta.shortChapterRatio * 100).toFixed(1)}%</div>
                  <div>标题命中率 {formatMetricPercent(activeSplitMeta.titleHitRate)}</div>
                  <div>编号连续性 {formatMetricPercent(activeSplitMeta.continuityScore)}</div>
                  <div>分布得分 {formatMetricPercent(activeSplitMeta.distributionScore)}</div>
                  <div>置信度 {(activeSplitMeta.confidence * 100).toFixed(1)}%</div>
                  {activeSplitMeta.reviewReasons.length > 0 && (
                    <div className="sm:col-span-2 text-amber-300/90">
                      复核原因：{activeSplitMeta.reviewReasons.join('；')}
                    </div>
                  )}
                </div>
              )}

              {resultDetailOpen && !activeSplitMeta && derivedStats && (
                <div className="mt-3 pt-3 border-t border-zinc-800 text-xs text-zinc-400 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>章节数 {derivedStats.chapterCount}</div>
                  <div>均章 {Math.round(derivedStats.avgChapterChars)} 字</div>
                  <div className="sm:col-span-2 text-amber-300/90">
                    历史导入，缺少质量指标 — 点击「重新评估」生成
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3 border border-zinc-800 rounded-xl p-3 bg-zinc-950/20">
              <button
                onClick={() => setAdvancedRepairOpen((prev) => !prev)}
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                {advancedRepairOpen ? '收起高级修复' : '高级修复（手动规则）'}
              </button>

              {advancedRepairOpen && (
                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div>
                    <label className="text-[10px] text-zinc-500 block mb-1">修复策略</label>
                    <select
                      value={repairStrategy}
                      onChange={(e) => setRepairStrategy(e.target.value as SplitStrategyId)}
                      className="w-full px-2 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none"
                    >
                      <option value="zh_strict">中文标准</option>
                      <option value="zh_extended">中文扩展</option>
                      <option value="mixed">中英混合</option>
                      <option value="en_basic">英文标准</option>
                      <option value="custom">自定义正则</option>
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    {repairStrategy === 'custom' ? (
                      <>
                        <label className="text-[10px] text-zinc-500 block mb-1">自定义分章正则</label>
                        <input
                          type="text"
                          value={repairRegex}
                          onChange={(e) => setRepairRegex(e.target.value)}
                          className="w-full px-2 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs font-mono focus:outline-none"
                        />
                      </>
                    ) : (
                      <button
                        onClick={() => void runResplit(repairStrategy)}
                        disabled={repairing}
                        className="w-full md:w-auto py-2 px-4 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-900 text-xs font-semibold disabled:opacity-50"
                      >
                        {repairing ? '重切处理中...' : '应用修复并重切'}
                      </button>
                    )}
                  </div>

                  {repairStrategy === 'custom' && (
                    <div className="md:col-span-3 flex justify-end">
                      <button
                        onClick={() => void runResplit('custom')}
                        disabled={repairing}
                        className="py-2 px-4 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-900 text-xs font-semibold disabled:opacity-50"
                      >
                        {repairing ? '重切处理中...' : '应用修复并重切'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
              <div>
                <h2 className="text-base font-semibold text-zinc-200">章节列表</h2>
                <p className="text-xs text-zinc-500 mt-0.5">共 {chapters.length} 章，可直接开始结构化解析。</p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={retryFailedChapters}
                  disabled={batchRun.active}
                  className="py-2 px-3 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-200 rounded-lg text-xs disabled:opacity-50"
                >
                  重试失败
                </button>
                <button
                  onClick={parseAllChapters}
                  disabled={batchRun.active}
                  className="py-2 px-3 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Cpu className="w-3.5 h-3.5" />
                  解析全部
                </button>
                {batchRun.active && (
                  <>
                    <button
                      onClick={() => (batchRun.paused ? resumeBatchRun() : pauseBatchRun())}
                      className="py-2 px-3 bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 text-zinc-200 rounded-lg text-xs font-medium flex items-center gap-1.5"
                    >
                      {batchRun.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                      {batchRun.paused ? '继续' : '暂停'}
                    </button>
                    <button
                      onClick={() => void cancelBatchRun()}
                      className="py-2 px-3 bg-rose-950/20 border border-rose-900/40 hover:bg-rose-900/25 text-rose-300 rounded-lg text-xs font-medium flex items-center gap-1.5"
                    >
                      <Square className="w-3.5 h-3.5" />
                      取消
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-col md:flex-row gap-2 items-center justify-between">
              <div className="relative w-full md:w-72">
                <input
                  type="text"
                  placeholder="搜索章节名称"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full pl-3 pr-8 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setCurrentPage(1);
                    }}
                    className="absolute right-2.5 top-1.5 text-zinc-500 hover:text-zinc-300 text-sm"
                  >
                    ×
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
                {(['all', 'unparsed', 'parsing', 'done', 'error'] as const).map((status) => {
                  const count = status === 'all'
                    ? chapterStatusStats.total
                    : status === 'unparsed'
                      ? chapterStatusStats.unparsed
                      : status === 'parsing'
                        ? chapterStatusStats.parsing
                        : status === 'done'
                          ? chapterStatusStats.done
                          : chapterStatusStats.error;
                  const label = status === 'all'
                    ? '全部'
                    : status === 'unparsed'
                      ? '待解析'
                      : status === 'parsing'
                        ? '解析中'
                        : status === 'done'
                          ? '已解析'
                          : '失败';
                  const active = statusFilter === status;
                  return (
                    <button
                      key={status}
                      onClick={() => {
                        setStatusFilter(status);
                        setCurrentPage(1);
                      }}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] whitespace-nowrap border ${
                        active
                          ? 'bg-zinc-800 text-zinc-100 border-zinc-700'
                          : 'bg-zinc-950/50 text-zinc-500 hover:text-zinc-300 border-zinc-900'
                      }`}
                    >
                      {label} ({count})
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Bulk Progress Panel */}
            {batchPanelStats && (
              <div className="mt-4 p-4 rounded-xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md flex flex-col gap-3.5 relative overflow-hidden group">
                {/* Flowing background shine */}
                <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-violet-500/5 via-indigo-500/5 to-transparent animate-pulse pointer-events-none" />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="flex h-2 w-2 relative">
                      {batchPanelStats.mode === 'active' && !batchPanelStats.paused ? (
                        <>
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                        </>
                      ) : batchPanelStats.mode === 'active' && batchPanelStats.paused ? (
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400"></span>
                      ) : (
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
                      )}
                    </span>
                    <h4 className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                      {batchPanelStats.mode === 'active'
                        ? (batchPanelStats.paused ? '批量解析已暂停' : '后台大模型结构化解析中')
                        : (batchPanelStats.cancelled ? '批量解析已取消' : '批量解析已完成')}
                    </h4>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-400 font-mono font-medium">
                      {batchPanelStats.mode === 'active' ? `并发上限: ${PARSE_CONCURRENCY_LIMIT}` : '结果摘要'}
                    </span>
                    {batchPanelStats.mode === 'summary' && (
                      <button
                        onClick={() => setLastBatchSummary(null)}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300"
                      >
                        隐藏
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-zinc-400 font-medium">
                      解析进度：{batchPanelStats.done} / {batchPanelStats.total} 章 ({batchPanelStats.progress}%)
                    </span>
                    <span className="text-zinc-400 font-mono">
                      {batchPanelStats.parsing} 个在途 · {batchPanelStats.error} 个失败
                    </span>
                  </div>

                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden p-[1px]">
                    <div
                      className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 rounded-full transition-all duration-500 ease-out shadow-[0_0_8px_rgba(99,102,241,0.4)]"
                      style={{ width: `${batchPanelStats.progress}%` }}
                    />
                  </div>
                </div>

                {batchPanelStats.error > 0 && (
                  <div className="flex items-center justify-between pt-1 text-[10px] border-t border-zinc-900/60">
                    <span className="text-rose-400/90 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" />
                      当前有 {batchPanelStats.error} 个章节解析失败，您可以点击重试
                    </span>
                    <button
                      onClick={retryFailedChapters}
                      disabled={batchRun.active}
                      className="text-zinc-400 hover:text-zinc-200 transition-colors font-medium flex items-center gap-1"
                    >
                      <RefreshCw className="w-2.5 h-2.5 animate-spin-hover" />
                      立即重试失败章节
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto mt-4 pr-1">
              {paginatedChapters.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-16 text-zinc-500">
                  <p className="text-sm font-medium">没有匹配章节</p>
                  <p className="text-xs text-zinc-400 mt-1">请尝试修改搜索词或筛选条件</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {paginatedChapters.map((chapter) => {
                    const isParsing = chapter.status === 'parsing';
                    const isSelected = selectedChapterId === chapter.id || activeDrawerChapterId === chapter.id;

                    return (
                      <div
                        key={chapter.id}
                        onClick={() => {
                          setSelectedChapterId(chapter.id);
                          setActiveDrawerChapterId(chapter.id);
                          if (chapter.status === 'error') {
                            setDrawerTab('error');
                          } else if (chapter.status === 'done') {
                            setDrawerTab('analysis');
                          } else {
                            setDrawerTab('text');
                          }
                        }}
                        className={`p-4 rounded-xl border cursor-pointer flex flex-col justify-between h-32 transition-all duration-250 ${
                          isSelected
                            ? 'bg-zinc-800/50 border-zinc-600 text-zinc-100 shadow-[0_4px_20px_rgba(0,0,0,0.15)] scale-[1.01]'
                            : 'bg-zinc-950/20 border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-900/10 text-zinc-400'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs text-zinc-400">Chapter {chapter.chapterIndex}</p>
                            <h4 className="font-medium text-sm text-zinc-200 truncate mt-1">{chapter.name}</h4>
                            <p className="text-[11px] text-zinc-400 mt-0.5">{chapter.wordCount} 字</p>
                          </div>

                          <div>
                            {chapter.status === 'done' && (
                              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-emerald-950/30 border border-emerald-900/40 text-emerald-300">
                                <CheckCircle2 className="w-3 h-3 text-emerald-300" />
                                已解析
                              </span>
                            )}
                            {chapter.status === 'unparsed' && (
                              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-400">
                                待解析
                              </span>
                            )}
                            {isParsing && (
                              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-indigo-950/30 border border-indigo-900/40 text-indigo-300">
                                <Loader2 className="w-3 h-3 animate-spin text-indigo-300" />
                                解析中
                              </span>
                            )}
                            {chapter.status === 'error' && (
                              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-rose-950/20 border border-rose-900/30 text-rose-300">
                                <AlertCircle className="w-3 h-3" />
                                失败
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between border-t border-zinc-800/80 pt-2 mt-2">
                          <div className="min-w-0 flex-1">
                            {chapter.status === 'error' ? (
                              <p className="text-[11px] text-rose-300 truncate pr-2" title={chapter.errorMsg || '解析出错'}>{chapter.errorMsg || '解析出错'}</p>
                            ) : chapter.status === 'done' ? (
                              <p className="text-[11px] text-zinc-300 truncate pr-2">
                                角色 {chapter.analysis?.characters?.length ?? 0} · 关系 {chapter.analysis?.relationships?.length ?? 0}
                              </p>
                            ) : (
                              <p className="text-[11px] text-zinc-400 truncate pr-2">暂无结构化结果</p>
                            )}
                          </div>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void parseChapter(chapter);
                            }}
                            disabled={isParsing || batchRun.active}
                            className="py-1 px-2.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 text-[11px] flex items-center gap-1 disabled:opacity-50"
                          >
                            <Play className="w-3 h-3" />
                            {chapter.status === 'done' ? '重解析' : '解析'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-zinc-800/80 pt-4 mt-4">
                <span className="text-[11px] text-zinc-400">第 {safePage} 页 / 共 {totalPages} 页（共 {filteredChapters.length} 章）</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                    disabled={safePage === 1}
                    className="py-1 px-3 rounded bg-zinc-950 border border-zinc-800 hover:bg-zinc-900 text-zinc-300 text-xs disabled:opacity-30"
                  >
                    上一页
                  </button>
                  <button
                    onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                    disabled={safePage === totalPages}
                    className="py-1 px-3 rounded bg-zinc-950 border border-zinc-800 hover:bg-zinc-900 text-zinc-300 text-xs disabled:opacity-30"
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed top-4 right-4 z-[70]">
          <div className={`px-4 py-2.5 rounded-xl border shadow-lg text-xs flex items-center gap-2 ${
            toast.tone === 'error'
              ? 'bg-rose-950/90 border-rose-800 text-rose-100'
              : toast.tone === 'success'
                ? 'bg-emerald-950/90 border-emerald-800 text-emerald-100'
                : 'bg-zinc-900/95 border-zinc-700 text-zinc-100'
          }`}>
            {toast.tone === 'error' ? <CircleX className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="关闭确认对话框"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setConfirmDialog(null)}
          />
          <div className="relative w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
            <h4 className="text-sm font-semibold text-zinc-100">{confirmDialog.title}</h4>
            <p className="text-xs text-zinc-400 mt-2 leading-relaxed">{confirmDialog.description}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDialog(null)}
                className="px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 text-xs hover:bg-zinc-800"
              >
                取消
              </button>
              <button
                onClick={() => void confirmDialog.onConfirm()}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                  confirmDialog.danger
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-900'
                }`}
              >
                {confirmDialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeDrawerChapterId && (
        <div className="fixed inset-0 z-[60] flex justify-end">
          <button
            type="button"
            aria-label="关闭章节详情"
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            onClick={() => setActiveDrawerChapterId(null)}
          />
          <aside className="relative h-full w-full max-w-2xl bg-zinc-900 border-l border-zinc-800 shadow-2xl animate-slide-in flex flex-col">
            <div className="p-4 border-b border-zinc-800 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] text-zinc-400 uppercase tracking-wider">章节详情</p>
                <h3 className="text-sm font-semibold text-zinc-100 truncate">
                  {drawerChapter ? drawerChapter.name : '章节未找到'}
                </h3>
                {drawerChapter && (
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    第 {drawerChapter.chapterIndex} 章 · {drawerChapter.wordCount} 字 · 状态 {drawerChapter.status}
                  </p>
                )}
              </div>
              <button
                onClick={() => setActiveDrawerChapterId(null)}
                className="p-1.5 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                aria-label="关闭章节详情"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-4 pt-3 flex items-center gap-2 border-b border-zinc-800">
              {([
                { id: 'text', label: '正文', icon: FileText },
                { id: 'analysis', label: '结构化分析', icon: Eye },
                { id: 'error', label: '错误详情', icon: AlertCircle },
              ] as const).map((tab) => {
                const active = drawerTab === tab.id;
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setDrawerTab(tab.id)}
                    className={`px-3 py-2 rounded-t-lg text-xs flex items-center gap-1.5 border ${
                      active
                        ? 'bg-zinc-800 border-zinc-700 text-zinc-100'
                        : 'bg-transparent border-transparent text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="p-4 overflow-y-auto flex-1">
              {!drawerChapter ? (
                <p className="text-xs text-zinc-400">未找到章节数据，可能已被删除。</p>
              ) : drawerTab === 'text' ? (
                <pre className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-200 font-sans">{drawerChapter.content}</pre>
              ) : drawerTab === 'analysis' ? (
                drawerChapter.status === 'done' && drawerChapter.analysis ? (
                  <div className="space-y-4 text-xs text-zinc-200">
                    <section>
                      <h4 className="text-zinc-100 font-semibold mb-1.5">世界观</h4>
                      <p className="text-zinc-300 leading-relaxed">{drawerChapter.analysis.worldview}</p>
                    </section>
                    <section>
                      <h4 className="text-zinc-100 font-semibold mb-1.5">核心骨架</h4>
                      <p className="text-zinc-300 leading-relaxed">{drawerChapter.analysis.plotSkeleton}</p>
                    </section>
                    <section>
                      <h4 className="text-zinc-100 font-semibold mb-1.5">角色（{drawerChapter.analysis.characters.length}）</h4>
                      <div className="space-y-2">
                        {drawerChapter.analysis.characters.map((char, idx) => (
                          <div key={`${char.name}-${idx}`} className="p-2 rounded-lg border border-zinc-800 bg-zinc-950/60">
                            <p className="text-zinc-100 font-medium">{char.name}</p>
                            <p className="text-zinc-300 mt-1">性格：{char.personality}</p>
                            <p className="text-zinc-300">外貌：{char.appearance}</p>
                            <p className="text-zinc-300">冲突：{char.coreConflict}</p>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section>
                      <h4 className="text-zinc-100 font-semibold mb-1.5">人物关系（{drawerChapter.analysis.relationships.length}）</h4>
                      <div className="space-y-2">
                        {drawerChapter.analysis.relationships.map((rel, idx) => (
                          <div key={`${rel.roleA}-${rel.roleB}-${idx}`} className="p-2 rounded-lg border border-zinc-800 bg-zinc-950/60 text-zinc-300">
                            {rel.roleA} ↔ {rel.roleB}：{rel.description}
                          </div>
                        ))}
                      </div>
                    </section>
                    <section>
                      <h4 className="text-zinc-100 font-semibold mb-1.5">叙事风格</h4>
                      <p className="text-zinc-300 leading-relaxed">{drawerChapter.analysis.style}</p>
                    </section>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-400">该章节尚未完成结构化解析。</p>
                )
              ) : (
                <div className="rounded-lg border border-rose-900/40 bg-rose-950/20 p-3 text-xs text-rose-200 whitespace-pre-wrap">
                  {drawerChapter.errorMsg || '暂无错误详情。'}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
