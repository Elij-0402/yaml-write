import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel, type SplitConfidenceLevel, type SplitMeta, type SplitStatus, type SplitStrategyId, type WinnerStrategyId } from '../app/db';
import { useAppStore } from '../app/store';
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

type BaseStrategyId = Exclude<SplitStrategyId, 'custom' | 'auto_v2'>;

const BASE_STRATEGIES: BaseStrategyId[] = ['zh_strict', 'zh_extended', 'mixed', 'en_basic'];

const STRATEGY_REGEX: Record<BaseStrategyId, string> = {
  zh_strict: '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$',
  zh_extended: '^\\s*((?:第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节]|序章|楔子|引子|前言|后记|尾声|终章|番外|完结感言)\\s*.*?)$',
  mixed: '^\\s*((?:第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*|(?:序章|楔子|引子|前言|后记|尾声|终章|番外|完结感言).*|(?:Chapter|CHAPTER|chapter)\\s*\\d+.*))$',
  en_basic: '^\\s*((?:Chapter|CHAPTER|chapter)\\s*\\d+.*?)$',
};

const V2_EXTRA_REGEX = '^\\s*((?:正文\\s*)?第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';

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

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`;
  return `${count}`;
}

function isWinnerStrategyId(value: unknown): value is WinnerStrategyId {
  return value === 'zh_strict' || value === 'zh_extended' || value === 'mixed' || value === 'en_basic' || value === 'custom';
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toLineRegex(pattern: string): RegExp {
  if (!pattern.trim()) throw new Error('empty regex pattern');
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
  if (!trimmed) return '请填写正则';
  if (trimmed.length > MAX_CUSTOM_REGEX_LENGTH) return '正则过长';

  const blockedPatterns = [/\\n|\\r/, /\r|\n/, /\[\\s\\S\]/, /\(\?:\.\|\\n\)/, /\(\?s[:)]/, /\\A|\\Z/];
  if (blockedPatterns.some((rule) => rule.test(pattern))) return '不支持跨行正则';
  if (hasNestedQuantifierRisk(trimmed)) return '正则包含高风险嵌套量词';

  try {
    const regex = toLineRegex(trimmed);
    const match = regex.exec('');
    if (match && match[0].length === 0) return '正则不能匹配空字符串';
  } catch {
    return '正则无效';
  }
  return null;
}

function normalizeGlyphs(line: string): string {
  return line
    .replace(/[​‌‍⁠﻿]/g, '')
    .replace(/[\u0000-\b\u000b-\u001f]/g, '')
    .replace(/　/g, ' ')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
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
  for (const pattern of adPatterns) cleaned = cleaned.replace(pattern, '');
  const trimmed = cleaned.trim();
  if (trimmed.length > 0) {
    const lower = trimmed.toLowerCase();
    if (trimmed.length < 35 && adKeywords.some((kw) => lower.includes(kw))) cleaned = '';
  }
  return { cleanedLine: cleaned, removedCount: Math.max(0, originalLength - cleaned.length) };
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
    if (matchedCount > SPLIT_MATCH_LIMIT) throw new Error('匹配次数超过安全阈值');
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
    if (elapsed > SPLIT_TIME_BUDGET_MS) throw new Error('正则执行超时');
    if (match[0].length === 0) { regex.lastIndex = match.index + 1; continue; }
    const title = (match[1] || match[0] || '').trim();
    if (title) positions.push({ title, index: match.index });
  }

  if (positions.length === 0) {
    return [{ title: '第一章 正文', content: normalizedText, wordCount: normalizedText.length, chapterIndex: 1 }];
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
    chapters.push({ title: current.title, content, wordCount: content.length, chapterIndex: i + 1 + offset });
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
      if (!prevEmpty) finalLines.push('');
      prevEmpty = true;
    } else {
      finalLines.push(cleanedLine);
      prevEmpty = false;
    }
  }

  const cleanedText = finalLines.join('\n').trim();
  return { cleanedText, removedCount: Math.max(removedCount, Math.max(0, originalLength - cleanedText.length)) };
}

function parseChineseNumber(raw: string): number | null {
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

function extractChapterNumber(title: string): number | null {
  const en = title.match(/(?:chapter|CHAPTER|Chapter)\s*(\d{1,6})/);
  if (en?.[1]) return Number.parseInt(en[1], 10);
  const zh = title.match(/第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*[章节回卷篇幕节]/);
  if (!zh?.[1]) return null;
  return parseChineseNumber(zh[1]);
}

function computeTitleHitRate(chapters: ParsedChapter[]): number {
  if (chapters.length === 0) return 0;
  let hit = 0;
  for (const chapter of chapters) if (extractChapterNumber(chapter.title) !== null) hit += 1;
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
    if (diff === 1) score += 1;
    else if (diff > 1 && diff <= 3) score += 0.6;
    else if (diff === 0) score += 0.2;
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

  const splitStatus: SplitStatus = confidenceLevel === 'low' ? 'needs_review' : 'ok';

  return { splitStatus, chapterCount, avgChapterChars, maxChapterRatio, shortChapterRatio, titleHitRate, continuityScore, distributionScore, confidence, confidenceLevel, reviewReasons };
}

function buildSplitMeta(
  strategyId: SplitStrategyId,
  quality: SplitQuality,
  engineVersion: 'v1' | 'v2',
  options?: { selectionMode?: SplitMeta['selectionMode']; winnerStrategyId?: WinnerStrategyId },
): SplitMeta {
  const selectionMode = options?.selectionMode || (strategyId === 'auto_v2' ? 'auto_v2' : 'manual');
  const winnerStrategyId = options?.winnerStrategyId || (strategyId !== 'auto_v2' && isWinnerStrategyId(strategyId) ? strategyId : undefined);
  return {
    strategyId, selectionMode, winnerStrategyId, chapterCount: quality.chapterCount, avgChapterChars: quality.avgChapterChars,
    maxChapterRatio: quality.maxChapterRatio, shortChapterRatio: quality.shortChapterRatio, confidence: quality.confidence,
    confidenceLevel: quality.confidenceLevel, reviewReasons: quality.reviewReasons, titleHitRate: quality.titleHitRate,
    continuityScore: quality.continuityScore, distributionScore: quality.distributionScore, engineVersion, updatedAt: Date.now(),
  };
}

function runSplitWithPattern(text: string, regexPattern: string, strategyId: SplitStrategyId, engineVersion: 'v1' | 'v2'): SplitCandidate {
  const chapters = splitNovel(text, regexPattern);
  const quality = evaluateSplitQuality(chapters, text.length);
  return { strategyId, chapters, splitStatus: quality.splitStatus, splitMeta: buildSplitMeta(strategyId, quality, engineVersion) };
}

function selectBetterCandidate(a: SplitCandidate, b: SplitCandidate): SplitCandidate {
  if (a.splitMeta.confidence !== b.splitMeta.confidence) return a.splitMeta.confidence > b.splitMeta.confidence ? a : b;
  if (a.splitMeta.chapterCount !== b.splitMeta.chapterCount) return a.splitMeta.chapterCount > b.splitMeta.chapterCount ? a : b;
  if (a.splitMeta.maxChapterRatio !== b.splitMeta.maxChapterRatio) return a.splitMeta.maxChapterRatio < b.splitMeta.maxChapterRatio ? a : b;
  return a.splitMeta.shortChapterRatio < b.splitMeta.shortChapterRatio ? a : b;
}

async function autoSplitAsync(text: string, onProgress?: (i: number, n: number) => void): Promise<SplitCandidate> {
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
    splitMeta: { ...best!.splitMeta, strategyId: 'auto_v2', selectionMode: 'auto_v2', winnerStrategyId: isWinnerStrategyId(best!.strategyId) ? best!.strategyId : undefined, engineVersion: 'v2', updatedAt: Date.now() },
  };
}

async function runSplitWithStrategy(text: string, strategyId: SplitStrategyId, customRegex?: string, onProgress?: (i: number, n: number) => void): Promise<SplitCandidate> {
  if (strategyId === 'custom') {
    const pattern = customRegex?.trim() ? customRegex : DEFAULT_CUSTOM_REGEX;
    const regexValidationError = validateLineRegex(pattern);
    if (regexValidationError) throw new Error(regexValidationError);
    return runSplitWithPattern(text, pattern, 'custom', 'v2');
  }
  if (strategyId === 'auto_v2') return autoSplitAsync(text, onProgress);
  return runSplitWithPattern(text, STRATEGY_REGEX[strategyId], strategyId, 'v2');
}

function chaptersToDbRows(novelId: string, parsedChapters: ParsedChapter[]): Chapter[] {
  return parsedChapters.map((chapter) => ({
    id: crypto.randomUUID(), novelId, chapterIndex: chapter.chapterIndex, name: chapter.title,
    wordCount: chapter.wordCount, content: chapter.content, status: 'unparsed', mapStatus: 'pending',
  }));
}

export default function NovelUploader() {
  const { selectedNovelId, setSelectedNovelId, setManageMode } = useAppStore();

  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadStageText, setUploadStageText] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
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
  const splitMeta = activeNovel?.splitMeta;
  const reviewReasons = splitMeta?.reviewReasons || [];

  const resetChapterListView = () => { setCurrentPage(1); setSearchQuery(''); };

  const stageLabelMap: Record<UploadStage, string> = {
    idle: '', detecting: '检测编码', reading: '读取文本', splitting: '分章', saving: '保存',
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) await processFile(e.dataTransfer.files[0]);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) await processFile(e.target.files[0]);
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
    if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return 'UTF-8';
    if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return 'UTF-16LE';
    if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return 'UTF-16BE';
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
    if (normalized.includes('GB2312') || normalized.includes('GBK') || normalized.includes('GB18030') || normalized.includes('WINDOWS936')) return 'GB18030';
    return null;
  };

  const detectEncoding = async (file: File): Promise<Encoding> => {
    try {
      const detectLength = Math.min(file.size, 50000);
      const detectBuffer = new Uint8Array(await readBlobAsArrayBuffer(file.slice(0, detectLength)));
      const bomEncoding = detectBomEncoding(detectBuffer);
      if (bomEncoding) return bomEncoding;

      let binaryStr = '';
      for (let i = 0; i < detectBuffer.length; i++) binaryStr += String.fromCharCode(detectBuffer[i]);

      let detectedEncoding: string | undefined;
      try { const result = jschardet.detect(binaryStr); detectedEncoding = result?.encoding; } catch { detectedEncoding = undefined; }

      let normalizedEncoding = normalizeDetectedEncoding(detectedEncoding, detectBuffer);
      if (!normalizedEncoding) normalizedEncoding = guessUtf16Endianness(detectBuffer) || 'GB18030';

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
      throw new Error('编码识别失败');
    }
  };

  const readTextWithEncoding = async (file: File, encoding: Encoding): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const result = ev.target?.result;
        if (typeof result !== 'string') { reject(new Error('解码结果为空')); return; }
        resolve(result);
      };
      reader.onerror = () => reject(new Error(`无法按 ${encoding} 解码`));
      reader.readAsText(file, getEncodingLabel(encoding));
    });
  };

  const ensureStorageCapacity = async (file: File): Promise<void> => {
    const storageManager = (navigator as Navigator & { storage?: StorageManager }).storage;
    if (!storageManager || typeof storageManager.estimate !== 'function') return;
    try {
      const estimate = await storageManager.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      if (!quota) return;
      const freeBytes = quota - usage;
      const requiredBytes = Math.max(file.size * 2.2, 8 * 1024 * 1024);
      if (freeBytes < requiredBytes) throw new Error('存储空间不足');
    } catch (err) {
      if (err instanceof Error && err.message.includes('存储空间')) throw err;
    }
  };

  const readAndCleanLargeFile = async (file: File, encoding: Encoding): Promise<CleanedTextResult> => {
    setUploadStage('reading');
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
        if (!previousLineWasEmpty) cleanedLines.push('');
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
      setUploadStageText(`${Math.min(100, Math.floor((totalRead / file.size) * 100))}%`);
      await pauseToKeepUiResponsive();
    }

    const tailText = decoder.decode();
    originalTotalLength += tailText.length;
    pendingFragment += tailText;
    if (pendingFragment.length > 0) pushLine(pendingFragment);

    const cleanedText = cleanedLines.join('\n').trim();
    return { cleanedText, removedCount: Math.max(removedCount, Math.max(0, originalTotalLength - cleanedText.length)) };
  };

  const loadAndCleanText = async (file: File, encoding: Encoding): Promise<CleanedTextResult> => {
    if (file.size > LARGE_FILE_THRESHOLD_BYTES) return readAndCleanLargeFile(file, encoding);
    setUploadStage('reading');
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
        wordCount: totalWords, splitStatus: splitResult.splitStatus, splitMeta: splitResult.splitMeta,
        analysisStatus: 'idle', mapProgress: { total: 0, current: 0 }, dnaCard: null,
      });
    });
  };

  const processFile = async (file: File) => {
    if (uploading || repairing) return;
    if (!file.name.toLowerCase().endsWith('.txt')) { setErrorMsg('仅支持 .txt'); return; }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) { setErrorMsg(`文件过大 (>${MAX_UPLOAD_SIZE_MB}MB)`); return; }

    setUploading(true);
    setUploadStage('detecting');
    setUploadStageText('');
    setErrorMsg(null);

    const novelId = crypto.randomUUID();
    const novelName = file.name.replace(/\.[^/.]+$/, '');

    try {
      await ensureStorageCapacity(file);
      const encoding = await detectEncoding(file);
      const { cleanedText, removedCount } = await loadAndCleanText(file, encoding);
      setUploadStage('splitting');
      const splitResult = await autoSplitAsync(cleanedText, (i, n) => setUploadStageText(`${i}/${n}`));
      const chaptersToSave = chaptersToDbRows(novelId, splitResult.chapters);
      const totalWords = splitResult.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

      setUploadStage('saving');
      await db.transaction('rw', db.novels, db.chapters, async () => {
        await db.novels.add({
          id: novelId, name: novelName, wordCount: totalWords, createdAt: Date.now(), purifiedCount: removedCount,
          sourceTextCleaned: cleanedText, splitStatus: splitResult.splitStatus, splitMeta: splitResult.splitMeta,
          analysisStatus: 'idle', mapProgress: { total: 0, current: 0 }, dnaCard: null,
        });
        await db.chapters.bulkAdd(chaptersToSave);
      });

      setSelectedNovelId(novelId);
      resetChapterListView();
    } catch (err: any) {
      setErrorMsg(err?.message || '处理失败');
    } finally {
      setUploading(false);
      setUploadStage('idle');
      setUploadStageText('');
    }
  };

  const doResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;
    if (!activeNovel.sourceTextCleaned.trim()) { setErrorMsg('文本缓存缺失'); return; }
    if (strategy === 'custom') {
      if (!repairRegex.trim()) { setErrorMsg('请填写正则'); return; }
      const regexValidationError = validateLineRegex(repairRegex);
      if (regexValidationError) { setErrorMsg(regexValidationError); return; }
    }

    setRepairing(true);
    setErrorMsg(null);
    setUploadStage('splitting');

    try {
      const splitResult = await runSplitWithStrategy(activeNovel.sourceTextCleaned, strategy, strategy === 'custom' ? repairRegex : undefined, (i, n) => setUploadStageText(`${i}/${n}`));
      await persistSplitResult(activeNovel.id, splitResult);
      resetChapterListView();
    } catch (err: any) {
      setErrorMsg(err?.message || '重分失败');
    } finally {
      setRepairing(false);
      setUploadStage('idle');
      setUploadStageText('');
    }
  };

  const runResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;
    if (!window.confirm('将覆盖所有章节数据并清空 DNA 进度')) return;
    await doResplit(strategy);
  };

  const filteredChapters = chapters.filter((chapter) => chapter.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const pageSize = 20;
  const totalPages = Math.ceil(filteredChapters.length / pageSize) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const paginatedChapters = filteredChapters.slice(startIndex, startIndex + pageSize);

  // Upload View
  if (!selectedNovelId) {
    return (
      <div
        className="max-w-xl space-y-6"
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
      >
        <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".txt" className="hidden" />

        {dragActive && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90">
            <p className="text-secondary">释放文件</p>
          </div>
        )}

        <div>
          <h1 className="text-lg">导入作品</h1>
          <p className="mt-1 text-sm text-secondary">上传 TXT 文件</p>
        </div>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full border border-dashed p-8 text-center text-sm text-secondary hover:text-primary"
        >
          点击选择或拖拽文件
          <br />
          <span className="text-xs text-muted">支持 UTF-8/GBK/Big5，最大 50MB</span>
        </button>

        {uploading && (
          <p className="text-sm text-secondary">
            {stageLabelMap[uploadStage]} {uploadStageText}
          </p>
        )}

        {errorMsg && <p className="text-sm text-red-400">{errorMsg}</p>}
      </div>
    );
  }

  // Chapter Review View
  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg">{activeNovel?.name}</h1>
          <p className="mt-1 text-sm text-secondary">
            {formatWordCount(activeNovel?.wordCount || 0)}字 · {chapters.length}章 · 均 {Math.round(derivedStats?.avgChapterChars ?? 0)}字/章
          </p>
        </div>
        <div className="flex gap-4 text-sm">
          {needsSmartRepair ? (
            <button onClick={() => void runResplit('auto_v2')} disabled={repairing} className="text-secondary hover:text-primary disabled:text-muted">
              {repairing ? '修复中...' : '智能修复'}
            </button>
          ) : (
            <button onClick={() => setManageMode(false)} className="text-secondary hover:text-primary">
              前往 DNA 提炼 →
            </button>
          )}
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-4 text-sm">
        <span className={needsSmartRepair ? 'text-amber-500' : 'text-emerald-500'}>
          {needsSmartRepair ? '○ 需要校验' : '● 结构完好'}
        </span>
        {splitMeta && <span className="text-muted">置信度 {Math.round(splitMeta.confidence * 100)}%</span>}
        {reviewReasons.length > 0 && <span className="text-muted">{reviewReasons.join(' · ')}</span>}
      </div>

      {(uploading || repairing || errorMsg) && (
        <p className={`text-sm ${errorMsg ? 'text-red-400' : 'text-secondary'}`}>
          {errorMsg || `${stageLabelMap[uploadStage]} ${uploadStageText}`}
        </p>
      )}

      {/* Advanced */}
      <div className="border-t pt-4">
        <button onClick={() => setShowAdvanced(!showAdvanced)} className="text-sm text-muted hover:text-secondary">
          {showAdvanced ? '收起手动分章' : '手动分章规则'}
        </button>
        {showAdvanced && (
          <div className="mt-4 space-y-4">
            <div className="flex gap-4">
              <select
                value={repairStrategy}
                onChange={(e) => setRepairStrategy(e.target.value as SplitStrategyId)}
                className="border bg-transparent p-2 text-sm focus:outline-none"
              >
                <option value="auto_v2">自动</option>
                <option value="zh_strict">中文严格</option>
                <option value="zh_extended">中文扩展</option>
                <option value="mixed">混合</option>
                <option value="en_basic">英文</option>
                <option value="custom">自定义</option>
              </select>
              <button
                onClick={() => void runResplit(repairStrategy)}
                disabled={repairing}
                className="text-sm text-secondary hover:text-primary disabled:text-muted"
              >
                执行
              </button>
            </div>
            {repairStrategy === 'custom' && (
              <input
                type="text"
                value={repairRegex}
                onChange={(e) => setRepairRegex(e.target.value)}
                className="w-full border bg-transparent p-2 text-sm font-mono focus:outline-none"
              />
            )}
          </div>
        )}
      </div>

      {/* Chapter List */}
      <div className="space-y-4">
        <input
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
          placeholder="搜索章节..."
          className="w-full border bg-transparent p-2 text-sm focus:outline-none"
        />

        <div className="border">
          <div className="flex border-b px-4 py-2 text-xs text-muted">
            <span className="w-16">#</span>
            <span className="flex-1">标题</span>
            <span className="w-20 text-right">字数</span>
          </div>
          {paginatedChapters.length === 0 ? (
            <p className="p-4 text-sm text-muted">无结果</p>
          ) : (
            paginatedChapters.map((chapter) => (
              <div key={chapter.id} className="flex border-b last:border-0 px-4 py-2 text-sm hover:bg-secondary/30">
                <span className="w-16 text-muted">{chapter.chapterIndex}</span>
                <span className="flex-1 truncate">{chapter.name}</span>
                <span className="w-20 text-right text-muted">{chapter.wordCount}</span>
              </div>
            ))
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-muted">
            <span>{safePage}/{totalPages}</span>
            <div className="flex gap-4">
              <button onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))} disabled={safePage === 1} className="hover:text-primary disabled:opacity-30">上一页</button>
              <button onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))} disabled={safePage === totalPages} className="hover:text-primary disabled:opacity-30">下一页</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
