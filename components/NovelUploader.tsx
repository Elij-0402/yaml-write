import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel, type SplitConfidenceLevel, type SplitMeta, type SplitStatus, type SplitStrategyId } from '../app/db';
import { useAppStore } from '../app/store';
import { AlertCircle, AlertTriangle, BookOpen, CheckCircle2, Cpu, Loader2, Play, Trash2, Upload, X, Eye, Sparkles, ChevronRight, FileText, RefreshCw, Layers, HelpCircle } from 'lucide-react';
import jschardet from 'jschardet';

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const LARGE_FILE_THRESHOLD_BYTES = 20 * 1024 * 1024;
const READ_CHUNK_SIZE_BYTES = 512 * 1024;
const SHORT_CHAPTER_CHAR_LIMIT = 120;
const DEFAULT_CUSTOM_REGEX = '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';

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
type Encoding = 'UTF-8' | 'GB18030' | 'UTF-16LE';

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
  continuityScore: number;
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
  /&nbsp;/g,
  /&lt;/g,
  /&gt;/g,
  /&amp;/g,
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

function validateLineRegex(pattern: string): string | null {
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

  return null;
}

function cleanLine(line: string): { cleanedLine: string; removedCount: number } {
  const originalLength = line.length;
  let cleaned = line;

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
  const regex = new RegExp(regexPattern, 'gm');
  const positions: { title: string; index: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalizedText)) !== null) {
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
      chapterIndex: i + 1,
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

function computeTitleHitRate(chapters: ParsedChapter[]): number {
  if (chapters.length === 0) return 0;

  let hit = 0;
  for (const chapter of chapters) {
    const firstLine = normalizeText(chapter.content).split('\n').find((line) => line.trim().length > 0) || '';
    const normalizedTitle = chapter.title.replace(/\s+/g, '');
    const normalizedFirst = firstLine.trim().replace(/\s+/g, '');

    if (!normalizedTitle || !normalizedFirst) continue;

    const probe = normalizedTitle.slice(0, Math.min(12, normalizedTitle.length));
    if (probe && normalizedFirst.includes(probe)) {
      hit += 1;
    }
  }

  return hit / chapters.length;
}

function computeContinuityScore(chapters: ParsedChapter[]): number {
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

  if (pairs === 0) return 0.55;
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

  const confidence = clamp(
    distributionScore * 0.45 + continuityScore * 0.3 + titleHitRate * 0.25,
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
  if (continuityScore < 0.42) reviewReasons.push(REVIEW_REASON_TEXT.weak_continuity);
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

function buildSplitMeta(strategyId: SplitStrategyId, quality: SplitQuality, engineVersion: 'v1' | 'v2'): SplitMeta {
  return {
    strategyId,
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

function autoSplit(text: string): SplitCandidate {
  const candidates: SplitCandidate[] = [
    ...BASE_STRATEGIES.map((strategy) => runSplitWithPattern(text, STRATEGY_REGEX[strategy], strategy, 'v2')),
    runSplitWithPattern(text, V2_EXTRA_REGEX, 'zh_extended', 'v2'),
  ];

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    best = selectBetterCandidate(best, candidates[i]);
  }

  return {
    ...best,
    strategyId: 'auto_v2',
    splitMeta: {
      ...best.splitMeta,
      strategyId: 'auto_v2',
      engineVersion: 'v2',
      updatedAt: Date.now(),
    },
  };
}

function runSplitWithStrategy(text: string, strategyId: SplitStrategyId, customRegex?: string): SplitCandidate {
  if (strategyId === 'custom') {
    const pattern = customRegex?.trim() ? customRegex : DEFAULT_CUSTOM_REGEX;
    return runSplitWithPattern(text, pattern, 'custom', 'v2');
  }
  if (strategyId === 'auto_v2') {
    return autoSplit(text);
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
  const { llmConfig, selectedNovelId, setSelectedNovelId, selectedChapterId, setSelectedChapterId } = useAppStore();

  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadStageText, setUploadStageText] = useState('');
  const [parsingQueue, setParsingQueue] = useState<Record<string, boolean>>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unparsed' | 'parsing' | 'done' | 'error'>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const [advancedRepairOpen, setAdvancedRepairOpen] = useState(false);
  const [resultDetailOpen, setResultDetailOpen] = useState(false);
  const [repairStrategy, setRepairStrategy] = useState<SplitStrategyId>('zh_extended');
  const [repairRegex, setRepairRegex] = useState(DEFAULT_CUSTOM_REGEX);
  const [repairing, setRepairing] = useState(false);

  // New states for slide-out Chapter Detail review drawer
  const [activeDrawerChapterId, setActiveDrawerChapterId] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<'text' | 'analysis' | 'error'>('text');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const novels = useLiveQuery<Novel[]>(() => db.novels.reverse().toArray(), []) || [];
  const chapters = useLiveQuery<Chapter[]>(() => {
    if (!selectedNovelId) return [];
    return db.chapters.where('novelId').equals(selectedNovelId).sortBy('chapterIndex');
  }, [selectedNovelId]) || [];

  const activeNovel = novels.find((n) => n.id === selectedNovelId) || null;

  const activeSplitMeta = useMemo<SplitMeta | null>(() => {
    if (!activeNovel?.splitMeta) return null;
    const meta = activeNovel.splitMeta;
    return {
      strategyId: meta.strategyId,
      chapterCount: meta.chapterCount,
      avgChapterChars: meta.avgChapterChars,
      maxChapterRatio: meta.maxChapterRatio,
      shortChapterRatio: meta.shortChapterRatio,
      confidence: typeof meta.confidence === 'number' ? meta.confidence : 0.5,
      confidenceLevel: meta.confidenceLevel || (activeNovel.splitStatus === 'needs_review' ? 'low' : 'medium'),
      reviewReasons: meta.reviewReasons || [],
      titleHitRate: typeof meta.titleHitRate === 'number' ? meta.titleHitRate : 0,
      continuityScore: typeof meta.continuityScore === 'number' ? meta.continuityScore : 0,
      distributionScore: typeof meta.distributionScore === 'number' ? meta.distributionScore : 0.5,
      engineVersion: meta.engineVersion || 'v1',
      updatedAt: meta.updatedAt,
    };
  }, [activeNovel]);

  const needsSmartRepair = activeSplitMeta?.confidenceLevel === 'low';

  // Compute parsing aggregate metrics for the Bulk Progress Panel
  const bulkStats = useMemo(() => {
    if (chapters.length === 0) return null;
    const total = chapters.length;
    const done = chapters.filter((c) => c.status === 'done').length;
    const parsing = chapters.filter((c) => c.status === 'parsing' || parsingQueue[c.id]).length;
    const error = chapters.filter((c) => c.status === 'error').length;
    const unparsed = chapters.filter((c) => c.status === 'unparsed').length;
    const progress = Math.round((done / total) * 100);

    return { total, done, parsing, error, unparsed, progress };
  }, [chapters, parsingQueue]);

  // Retrieve selected chapter reactive entity for the drawer details
  const drawerChapter = useMemo(() => {
    if (!activeDrawerChapterId) return null;
    return chapters.find((c) => c.id === activeDrawerChapterId) || null;
  }, [chapters, activeDrawerChapterId]);

  useEffect(() => {
    const recoverStaleParsing = async () => {
      const staleChapters = await db.chapters.where('status').equals('parsing').toArray();
      if (staleChapters.length === 0) return;
      await Promise.all(staleChapters.map((chapter) => db.chapters.update(chapter.id, {
        status: 'error',
        errorMsg: chapter.errorMsg || '上次解析任务已中断，请重试。',
      })));
    };
    void recoverStaleParsing();
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

  const detectEncoding = async (file: File): Promise<Encoding> => {
    try {
      const detectLength = Math.min(file.size, 50000);
      const detectBuffer = new Uint8Array(await readBlobAsArrayBuffer(file.slice(0, detectLength)));
      let binaryStr = '';
      for (let i = 0; i < detectBuffer.length; i++) {
        binaryStr += String.fromCharCode(detectBuffer[i]);
      }

      let encoding = 'UTF-8';
      try {
        const result = jschardet.detect(binaryStr);
        if (result?.encoding) {
          encoding = result.encoding;
        }
      } catch {
        encoding = 'UTF-8';
      }

      let normalizedEncoding = encoding.toUpperCase();
      if (
        normalizedEncoding.includes('GB2312')
        || normalizedEncoding.includes('GBK')
        || normalizedEncoding.includes('GB18030')
        || normalizedEncoding.includes('WINDOWS-936')
      ) {
        normalizedEncoding = 'GB18030';
      } else if (normalizedEncoding.includes('UTF-8') || normalizedEncoding.includes('ASCII')) {
        normalizedEncoding = 'UTF-8';
      } else if (normalizedEncoding.includes('UTF-16')) {
        normalizedEncoding = 'UTF-16LE';
      } else {
        normalizedEncoding = 'GB18030';
      }

      if (normalizedEncoding === 'UTF-8') {
        const sampleLength = Math.min(file.size, 2 * 1024 * 1024);
        const sample = new Uint8Array(await readBlobAsArrayBuffer(file.slice(0, sampleLength)));
        const sampleText = new TextDecoder('utf-8').decode(sample);
        const replacementCharCount = (sampleText.match(/\ufffd/g) || []).length;
        const replacementRatio = replacementCharCount / (sampleText.length || 1);
        if (replacementRatio > 0.01) {
          return 'GB18030';
        }
      }

      return normalizedEncoding as Encoding;
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
      reader.onerror = () => reject(new Error('编码失败：文本解码失败'));
      reader.readAsText(file, encoding);
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

    const decoder = new TextDecoder(encoding.toLowerCase());
    const cleanedLines: string[] = [];
    let pendingFragment = '';
    let previousLineWasEmpty = false;
    let removedCount = 0;
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
      pendingFragment += decodedText;
      const splitByLine = pendingFragment.split('\n');
      pendingFragment = splitByLine.pop() ?? '';
      splitByLine.forEach(pushLine);

      setUploadStage('reading');
      setUploadStageText(`分块读取进度：${Math.min(100, Math.floor((totalRead / file.size) * 100))}%`);
      await pauseToKeepUiResponsive();
    }

    pendingFragment += decoder.decode();
    if (pendingFragment.length > 0) {
      pushLine(pendingFragment);
    }

    const cleanedText = cleanedLines.join('\n').trim();
    return { cleanedText, removedCount };
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

  const parseChapter = async (chapter: Chapter) => {
    if (!llmConfig.apiKey) {
      alert('请先配置大模型 API Key！(在右上角设置面板)');
      return;
    }

    setParsingQueue((prev) => ({ ...prev, [chapter.id]: true }));
    await db.chapters.update(chapter.id, {
      status: 'parsing',
      errorMsg: undefined,
    });

    try {
      const response = await fetch('/api/py/parse-chapter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: chapter.name,
          content: chapter.content.slice(0, 15000),
          apiKey: llmConfig.apiKey,
          baseUrl: llmConfig.baseUrl,
          model: llmConfig.model,
          temperature: llmConfig.temperature,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || '接口解析失败');
      }

      const analysis = await response.json();
      await db.chapters.update(chapter.id, {
        status: 'done',
        analysis,
      });
    } catch (err: any) {
      await db.chapters.update(chapter.id, {
        status: 'error',
        errorMsg: err.message || '大模型解析出错',
      });
    } finally {
      setParsingQueue((prev) => ({ ...prev, [chapter.id]: false }));
    }
  };

  const parseChaptersInParallel = async (targets: Chapter[]) => {
    const concurrencyLimit = 3;
    let index = 0;

    const worker = async () => {
      while (index < targets.length) {
        const currentIdx = index++;
        const chapter = targets[currentIdx];
        await parseChapter(chapter);
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrencyLimit, targets.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
  };

  const parseAllChapters = async () => {
    if (!llmConfig.apiKey) {
      alert('请先配置大模型 API Key！');
      return;
    }

    const targets = chapters.filter((chapter) => chapter.status === 'unparsed' || chapter.status === 'error');
    if (targets.length === 0) {
      alert('没有可解析章节（待解析/失败章节为空）。');
      return;
    }

    if (!confirm(`准备解析 ${targets.length} 个章节，由于调用大模型可能产生流量和延迟，确定继续吗？`)) {
      return;
    }

    await parseChaptersInParallel(targets);
  };

  const retryFailedChapters = async () => {
    if (!llmConfig.apiKey) {
      alert('请先配置大模型 API Key！');
      return;
    }

    const failedChapters = chapters.filter((chapter) => chapter.status === 'error');
    if (failedChapters.length === 0) {
      alert('当前没有解析失败章节。');
      return;
    }

    if (!confirm(`准备重试 ${failedChapters.length} 个失败章节，确定继续吗？`)) {
      return;
    }

    await parseChaptersInParallel(failedChapters);
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
      const splitResult = autoSplit(cleanedText);
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
      if (chaptersToSave[0]) {
        setSelectedChapterId(chaptersToSave[0].id);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || '文件解析入库失败');
    } finally {
      setUploading(false);
      setUploadStage('idle');
      setUploadStageText('');
    }
  };

  const runResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;

    if (!activeNovel.sourceTextCleaned.trim()) {
      setErrorMsg('当前小说缺少原始文本缓存，请重新上传该小说以启用重切功能。');
      return;
    }

    if (!confirm('重切将覆盖当前小说的章节列表，并清空已有章节解析结果。确定继续吗？')) {
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
      const splitResult = runSplitWithStrategy(
        activeNovel.sourceTextCleaned,
        strategy,
        strategy === 'custom' ? repairRegex : undefined,
      );
      await persistSplitResult(activeNovel.id, splitResult);
    } catch (err: any) {
      setErrorMsg(err?.message || '重切失败，请检查规则后重试。');
    } finally {
      setRepairing(false);
    }
  };

  const deleteNovel = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确认删除这部小说及其所有章节解析吗？')) return;

    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(id).delete();
      await db.novels.delete(id);
    });

    if (selectedNovelId === id) {
      setSelectedNovelId(null);
      setSelectedChapterId(null);
      setActiveDrawerChapterId(null);
    }
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
                  setCurrentPage(1);
                  setSearchQuery('');
                  setStatusFilter('all');
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

      <div className="lg:col-span-3 bg-zinc-900/20 border border-zinc-800/70 rounded-2xl p-5 flex flex-col min-h-0 relative overflow-hidden">
        {!selectedNovelId ? (
          <div
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
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
                    分章完成 · {toConfidenceLabel(activeSplitMeta?.confidenceLevel || 'medium')} · {activeSplitMeta?.chapterCount ?? chapters.length}章 · 均章 {Math.round(activeSplitMeta?.avgChapterChars ?? 0)}字
                  </p>
                  <p className="text-[11px] text-zinc-500 mt-1">
                    引擎 {activeSplitMeta?.engineVersion === 'v2' ? 'V2' : 'V1'} · 策略 {activeSplitMeta ? STRATEGY_LABELS[activeSplitMeta.strategyId] : '未知'}
                  </p>
                </div>

                {needsSmartRepair && (
                  <div className="flex flex-col items-end gap-1">
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
                  </div>
                )}
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
                  <div>标题命中率 {(activeSplitMeta.titleHitRate * 100).toFixed(1)}%</div>
                  <div>编号连续性 {(activeSplitMeta.continuityScore * 100).toFixed(1)}%</div>
                  <div>分布得分 {(activeSplitMeta.distributionScore * 100).toFixed(1)}%</div>
                  <div>置信度 {(activeSplitMeta.confidence * 100).toFixed(1)}%</div>
                  {activeSplitMeta.reviewReasons.length > 0 && (
                    <div className="sm:col-span-2 text-amber-300/90">
                      复核原因：{activeSplitMeta.reviewReasons.join('；')}
                    </div>
                  )}
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
                  className="py-2 px-3 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-200 rounded-lg text-xs"
                >
                  重试失败
                </button>
                <button
                  onClick={parseAllChapters}
                  className="py-2 px-3 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                >
                  <Cpu className="w-3.5 h-3.5" />
                  解析全部
                </button>
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
                  const count = chapters.filter((chapter) => status === 'all' || chapter.status === status).length;
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
            {bulkStats && bulkStats.parsing > 0 && (
              <div className="mt-4 p-4 rounded-xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md flex flex-col gap-3.5 relative overflow-hidden group">
                {/* Flowing background shine */}
                <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-violet-500/5 via-indigo-500/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out pointer-events-none" />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                    </span>
                    <h4 className="text-xs font-semibold text-zinc-300">
                      后台大模型结构化解析中
                    </h4>
                  </div>
                  <span className="text-[10px] text-zinc-500 font-mono font-medium">
                    并发数限制: 3
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-zinc-400 font-medium">
                      解析进度：{bulkStats.done} / {bulkStats.total} 章 ({bulkStats.progress}%)
                    </span>
                    <span className="text-zinc-500 font-mono">
                      {bulkStats.parsing} 个在途 · {bulkStats.error} 个失败
                    </span>
                  </div>

                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden p-[1px]">
                    <div
                      className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 rounded-full transition-all duration-500 ease-out shadow-[0_0_8px_rgba(99,102,241,0.4)]"
                      style={{ width: `${bulkStats.progress}%` }}
                    />
                  </div>
                </div>

                {bulkStats.error > 0 && (
                  <div className="flex items-center justify-between pt-1 text-[10px] border-t border-zinc-900/60">
                    <span className="text-rose-400/90 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" />
                      当前有 {bulkStats.error} 个章节解析失败，您可以点击重试
                    </span>
                    <button
                      onClick={retryFailedChapters}
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
                  <p className="text-xs text-zinc-600 mt-1">请尝试修改搜索词或筛选条件</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {paginatedChapters.map((chapter) => {
                    const isParsing = parsingQueue[chapter.id] || chapter.status === 'parsing';
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
                            ? 'bg-zinc-800/50 border-zinc-650 text-zinc-100 shadow-[0_4px_20px_rgba(0,0,0,0.15)] scale-[1.01]'
                            : 'bg-zinc-950/20 border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-900/10 text-zinc-400'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs text-zinc-500">Chapter {chapter.chapterIndex}</p>
                            <h4 className="font-medium text-sm text-zinc-200 truncate mt-1">{chapter.name}</h4>
                            <p className="text-[10px] text-zinc-500 mt-0.5">{chapter.wordCount} 字</p>
                          </div>

                          <div>
                            {chapter.status === 'done' && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                                <CheckCircle2 className="w-3 h-3 text-zinc-400" />
                                已解析
                              </span>
                            )}
                            {chapter.status === 'unparsed' && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-500">
                                待解析
                              </span>
                            )}
                            {isParsing && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                                <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                                解析中
                              </span>
                            )}
                            {chapter.status === 'error' && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-rose-950/20 border border-rose-900/30 text-rose-400">
                                <AlertCircle className="w-3 h-3" />
                                失败
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between border-t border-zinc-800/80 pt-2 mt-2">
                          <div className="min-w-0 flex-1">
                            {chapter.status === 'error' ? (
                              <p className="text-[10px] text-rose-400 truncate pr-2">{chapter.errorMsg || '解析出错'}</p>
                            ) : chapter.status === 'done' ? (
                              <p className="text-[10px] text-zinc-400 truncate pr-2">
                                角色 {chapter.analysis?.characters?.length ?? 0} · 关系 {chapter.analysis?.relationships?.length ?? 0}
                              </p>
                            ) : (
                              <p className="text-[10px] text-zinc-600 truncate pr-2">暂无结构化结果</p>
                            )}
                          </div>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void parseChapter(chapter);
                            }}
                            disabled={isParsing}
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
                <span className="text-[10px] text-zinc-500">第 {safePage} 页 / 共 {totalPages} 页（共 {filteredChapters.length} 章）</span>
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
    </div>
  );
}
