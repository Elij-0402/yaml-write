// Web Worker for novel parsing and splitting
// Location: yaml-write/public/workers/novel-parser-worker.js

importScripts('jschardet.min.js');

const BASE_STRATEGIES = ['zh_strict', 'zh_extended', 'mixed', 'en_basic'];

const STRATEGY_REGEX = {
  zh_strict: '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$',
  zh_extended: '^\\s*((?:第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节]|序章|楔子|引子|前言|后记|尾声|终章|番外|完结感言)\\s*.*?)$',
  mixed: '^\\s*((?:第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*|(?:序章|楔子|引子|前言|后记|尾声|终章|番外|完结感言).*|(?:Chapter|CHAPTER|chapter)\\s*\\d+.*))$',
  en_basic: '^\\s*((?:Chapter|CHAPTER|chapter)\\s*\\d+.*?)$',
};

const V2_EXTRA_REGEX = '^\\s*((?:正文\\s*)?第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';
const DEFAULT_CUSTOM_REGEX = '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';
const MAX_CUSTOM_REGEX_LENGTH = 300;
const SPLIT_MATCH_LIMIT = 20000;
const SPLIT_TIME_BUDGET_MS = 2000;
const SHORT_CHAPTER_CHAR_LIMIT = 120;

const adPatterns = [
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toLineRegex(pattern) {
  if (!pattern.trim()) throw new Error('empty regex pattern');
  const inputRegex = new RegExp(pattern, 'm');
  const safeFlags = inputRegex.flags.replace('g', '').replace('y', '');
  return new RegExp(inputRegex.source, safeFlags);
}

function toGlobalLineRegex(pattern) {
  const lineRegex = toLineRegex(pattern);
  const flags = lineRegex.flags.includes('g') ? lineRegex.flags : `${lineRegex.flags}g`;
  return new RegExp(lineRegex.source, flags);
}

function hasNestedQuantifierRisk(pattern) {
  const nestedQuantifierRules = [
    /\((?:\\.|[^()]){0,240}(?:\*|\+|\{\d*,?\d*\})(?:\\.|[^()]){0,240}\)\s*(?:\*|\+|\{\d*,?\d*\})/,
    /\((?:\\.|[^()]){0,240}\.\*(?:\\.|[^()]){0,240}\)\s*(?:\*|\+)/,
    /\((?:\\.|[^()]){0,240}\.\+(?:\\.|[^()]){0,240}\)\s*(?:\*|\+)/,
  ];
  return nestedQuantifierRules.some((rule) => rule.test(pattern));
}

function validateLineRegex(pattern) {
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
  } catch (err) {
    return '正则无效';
  }
  return null;
}

function normalizeGlyphs(line) {
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

function cleanLine(line) {
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

function splitNovel(text, regexPattern) {
  const normalizedText = normalizeText(text);
  const regex = toGlobalLineRegex(regexPattern);
  const positions = [];
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let matchedCount = 0;

  let match;
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

  const chapters = [];
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

function cleanText(text) {
  const originalLength = text.length;
  const normalizedText = normalizeText(text);
  const lines = normalizedText.split('\n');
  const finalLines = [];
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

function parseChineseNumber(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const digitMap = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unitMap = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
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

function extractChapterNumber(title) {
  const en = title.match(/(?:chapter|CHAPTER|Chapter)\s*(\d{1,6})/);
  if (en?.[1]) return Number.parseInt(en[1], 10);
  const zh = title.match(/第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*[章节回卷篇幕节]/);
  if (!zh?.[1]) return null;
  return parseChineseNumber(zh[1]);
}

function computeTitleHitRate(chapters) {
  if (chapters.length === 0) return 0;
  let hit = 0;
  for (const chapter of chapters) if (extractChapterNumber(chapter.title) !== null) hit += 1;
  return hit / chapters.length;
}

function computeContinuityScore(chapters) {
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

// 纯评分逻辑已双拷贝至 app/splitQuality.ts（bundled TS，供组件在手动剪/合并/撤销后即时重算 splitStatus）。
// 改动此处权重/阈值须同步那份，否则「上传切分」与「手动重算」结果会漂移；由 app/splitQuality.test.ts 黄金向量对拍守护。
function evaluateSplitQuality(chapters, totalChars) {
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

  const weightedMetrics = [
    { value: distributionScore, weight: 0.45 },
    { value: titleHitRate, weight: 0.25 },
  ];
  if (typeof continuityScore === 'number') weightedMetrics.push({ value: continuityScore, weight: 0.3 });
  const totalWeight = weightedMetrics.reduce((sum, metric) => sum + metric.weight, 0) || 1;
  const confidence = clamp(weightedMetrics.reduce((sum, metric) => sum + metric.value * metric.weight, 0) / totalWeight, 0, 1);

  const confidenceLevel = confidence >= 0.8 ? 'high' : confidence >= 0.58 ? 'medium' : 'low';

  const reviewReasons = [];
  if (totalChars >= 8000 && chapterCount <= 1) reviewReasons.push('仅1章');
  if (maxChapterRatio >= 0.82) reviewReasons.push('超大章节');
  if (shortChapterRatio > 0.45) reviewReasons.push('短章过多');
  if (typeof continuityScore === 'number' && continuityScore < 0.42) reviewReasons.push('序号不连续');
  if (titleHitRate < 0.5) reviewReasons.push('标题命中低');

  const splitStatus = confidenceLevel === 'low' ? 'needs_review' : 'ok';

  return { splitStatus, chapterCount, avgChapterChars, maxChapterRatio, shortChapterRatio, titleHitRate, continuityScore, distributionScore, confidence, confidenceLevel, reviewReasons };
}

function buildSplitMeta(strategyId, quality, engineVersion, options) {
  const selectionMode = options?.selectionMode || (strategyId === 'auto_v2' ? 'auto_v2' : 'manual');
  const winnerStrategyId = options?.winnerStrategyId || (strategyId !== 'auto_v2' ? strategyId : undefined);
  return {
    strategyId, selectionMode, winnerStrategyId, chapterCount: quality.chapterCount, avgChapterChars: quality.avgChapterChars,
    maxChapterRatio: quality.maxChapterRatio, shortChapterRatio: quality.shortChapterRatio, confidence: quality.confidence,
    confidenceLevel: quality.confidenceLevel, reviewReasons: quality.reviewReasons, titleHitRate: quality.titleHitRate,
    continuityScore: quality.continuityScore, distributionScore: quality.distributionScore, engineVersion, updatedAt: Date.now(),
  };
}

function runSplitWithPattern(text, regexPattern, strategyId, engineVersion) {
  const chapters = splitNovel(text, regexPattern);
  const quality = evaluateSplitQuality(chapters, text.length);
  return { strategyId, chapters, splitStatus: quality.splitStatus, splitMeta: buildSplitMeta(strategyId, quality, engineVersion) };
}

function selectBetterCandidate(a, b) {
  if (a.splitMeta.confidence !== b.splitMeta.confidence) return a.splitMeta.confidence > b.splitMeta.confidence ? a : b;
  if (a.splitMeta.chapterCount !== b.splitMeta.chapterCount) return a.splitMeta.chapterCount > b.splitMeta.chapterCount ? a : b;
  if (a.splitMeta.maxChapterRatio !== b.splitMeta.maxChapterRatio) return a.splitMeta.maxChapterRatio < b.splitMeta.maxChapterRatio ? a : b;
  return a.splitMeta.shortChapterRatio < b.splitMeta.shortChapterRatio ? a : b;
}

async function autoSplitAsync(text, onProgress) {
  const patterns = [
    ...BASE_STRATEGIES.map((strategy) => [STRATEGY_REGEX[strategy], strategy]),
    [V2_EXTRA_REGEX, 'zh_extended'],
  ];

  let best = null;
  for (let i = 0; i < patterns.length; i++) {
    const [regex, strategyId] = patterns[i];
    const cand = runSplitWithPattern(text, regex, strategyId, 'v2');
    best = best ? selectBetterCandidate(best, cand) : cand;
    onProgress?.(i + 1, patterns.length);
  }

  return {
    ...best,
    strategyId: 'auto_v2',
    splitMeta: { ...best.splitMeta, strategyId: 'auto_v2', selectionMode: 'auto_v2', winnerStrategyId: best.strategyId, engineVersion: 'v2', updatedAt: Date.now() },
  };
}

async function runSplitWithStrategy(text, strategyId, customRegex, onProgress) {
  if (strategyId === 'custom') {
    const pattern = customRegex?.trim() ? customRegex : DEFAULT_CUSTOM_REGEX;
    const regexValidationError = validateLineRegex(pattern);
    if (regexValidationError) throw new Error(regexValidationError);
    return runSplitWithPattern(text, pattern, 'custom', 'v2');
  }
  if (strategyId === 'auto_v2') return autoSplitAsync(text, onProgress);
  return runSplitWithPattern(text, STRATEGY_REGEX[strategyId], strategyId, 'v2');
}

// ----------------------------------------------------
// Encoding Detection Logic (Adaptive and Silent)
// ----------------------------------------------------

const detectBomEncoding = (sample) => {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return 'UTF-8';
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return 'UTF-16LE';
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return 'UTF-16BE';
  return null;
};

const guessUtf16Endianness = (sample) => {
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

const getReplacementRatio = (sample, label) => {
  try {
    const decoded = new TextDecoder(label, { fatal: false }).decode(sample);
    if (!decoded) return 1;
    const replacementCharCount = (decoded.match(/\ufffd/g) || []).length;
    return replacementCharCount / decoded.length;
  } catch (err) {
    return Number.POSITIVE_INFINITY;
  }
};

const normalizeDetectedEncoding = (detected, sample) => {
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

async function detectEncoding(file) {
  try {
    const detectLength = Math.min(file.size, 50000);
    const detectBuffer = new Uint8Array(await file.slice(0, detectLength).arrayBuffer());
    const bomEncoding = detectBomEncoding(detectBuffer);
    if (bomEncoding) return bomEncoding;

    let binaryStr = '';
    for (let i = 0; i < detectBuffer.length; i++) {
      binaryStr += String.fromCharCode(detectBuffer[i]);
    }

    let detectedEncoding;
    try {
      const result = self.jschardet.detect(binaryStr);
      detectedEncoding = result?.encoding;
    } catch (err) {
      detectedEncoding = undefined;
    }

    let normalizedEncoding = normalizeDetectedEncoding(detectedEncoding, detectBuffer);
    if (!normalizedEncoding) normalizedEncoding = guessUtf16Endianness(detectBuffer) || 'GB18030';

    if (normalizedEncoding === 'UTF-8') {
      const sampleLength = Math.min(file.size, 2 * 1024 * 1024);
      const sample = new Uint8Array(await file.slice(0, sampleLength).arrayBuffer());
      const utf8Ratio = getReplacementRatio(sample, 'utf-8');
      if (utf8Ratio > 0.01) {
        const gbRatio = getReplacementRatio(sample, 'gb18030');
        const big5Ratio = getReplacementRatio(sample, 'big5');
        normalizedEncoding = (big5Ratio + 0.002 < gbRatio) ? 'BIG5' : 'GB18030';
      }
    }
    return normalizedEncoding;
  } catch (err) {
    throw new Error('编码识别失败: ' + err.message);
  }
}

// Get standard label for TextDecoder
const getEncodingLabel = (encoding) => {
  if (encoding === 'UTF-8') return 'utf-8';
  if (encoding === 'GB18030') return 'gb18030';
  if (encoding === 'BIG5') return 'big5';
  if (encoding === 'UTF-16LE') return 'utf-16le';
  return 'utf-16be';
};

// ----------------------------------------------------
// Chunked Reading & Cleaning
// ----------------------------------------------------
const READ_CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2MB as per AC2

async function readAndCleanFile(file, encoding, onProgress) {
  const decoder = new TextDecoder(getEncodingLabel(encoding));
  const cleanedLines = [];
  let pendingFragment = '';
  let previousLineWasEmpty = false;
  let removedCount = 0;
  let originalTotalLength = 0;
  let totalRead = 0;

  const pushLine = (rawLine) => {
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
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    totalRead += bytes.byteLength;
    const decodedText = decoder.decode(bytes, { stream: true });
    originalTotalLength += decodedText.length;
    pendingFragment += decodedText;
    const splitByLine = pendingFragment.split('\n');
    pendingFragment = splitByLine.pop() ?? '';
    splitByLine.forEach(pushLine);

    if (onProgress) {
      onProgress(Math.min(100, Math.floor((totalRead / file.size) * 100)));
    }
  }

  const tailText = decoder.decode();
  originalTotalLength += tailText.length;
  pendingFragment += tailText;
  if (pendingFragment.length > 0) pushLine(pendingFragment);

  const cleanedText = cleanedLines.join('\n').trim();
  return {
    cleanedText,
    removedCount: Math.max(removedCount, Math.max(0, originalTotalLength - cleanedText.length))
  };
}

// ----------------------------------------------------
// Cryptographic Hash Generation (SHA-256)
// ----------------------------------------------------
async function computeSha256(text) {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await self.crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

// ----------------------------------------------------
// Message Listener
// ----------------------------------------------------
self.onmessage = async function (e) {
  const { file, cleanedText: inputCleanedText, strategyId, customRegex, options } = e.data;

  try {
    if (file) {
      // Full pipeline: detect, read/clean, split
      self.postMessage({ type: 'progress', stage: 'detecting', percent: 0 });
      const encoding = await detectEncoding(file);
      
      self.postMessage({ type: 'progress', stage: 'reading', percent: 0 });
      const { cleanedText, removedCount } = await readAndCleanFile(file, encoding, (percent) => {
        self.postMessage({ type: 'progress', stage: 'reading', percent });
      });

      self.postMessage({ type: 'progress', stage: 'splitting', percent: 0 });
      const splitResult = await autoSplitAsync(cleanedText, (curr, total) => {
        self.postMessage({ type: 'progress', stage: 'splitting', percent: Math.floor((curr / total) * 100) });
      });

      // Calculate SHA-256 for all chapters
      self.postMessage({ type: 'progress', stage: 'hashing', percent: 0 });
      const chaptersWithHash = await Promise.all(
        splitResult.chapters.map(async (chapter, idx) => {
          const contentSha256 = await computeSha256(chapter.content);
          if (idx % 10 === 0) {
            self.postMessage({
              type: 'progress',
              stage: 'hashing',
              percent: Math.floor((idx / splitResult.chapters.length) * 100)
            });
          }
          return { ...chapter, contentSha256 };
        })
      );

      self.postMessage({
        type: 'success',
        data: {
          chapters: chaptersWithHash,
          splitMeta: splitResult.splitMeta,
          cleanedText,
          purifiedCount: removedCount
        }
      });
    } else if (inputCleanedText !== undefined) {
      // Split only (for manual repair/resplitting)
      self.postMessage({ type: 'progress', stage: 'splitting', percent: 0 });
      const splitResult = await runSplitWithStrategy(
        inputCleanedText,
        strategyId,
        customRegex,
        (curr, total) => {
          self.postMessage({ type: 'progress', stage: 'splitting', percent: Math.floor((curr / total) * 100) });
        }
      );

      self.postMessage({ type: 'progress', stage: 'hashing', percent: 0 });
      const chaptersWithHash = await Promise.all(
        splitResult.chapters.map(async (chapter, idx) => {
          const contentSha256 = await computeSha256(chapter.content);
          if (idx % 10 === 0) {
            self.postMessage({
              type: 'progress',
              stage: 'hashing',
              percent: Math.floor((idx / splitResult.chapters.length) * 100)
            });
          }
          return { ...chapter, contentSha256 };
        })
      );

      self.postMessage({
        type: 'success',
        data: {
          chapters: chaptersWithHash,
          splitMeta: splitResult.splitMeta,
          cleanedText: inputCleanedText,
          purifiedCount: 0 // Resplitting is already-purified text
        }
      });
    } else {
      throw new Error('无效的 Worker 请求参数');
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || 'Worker 内部执行出错' });
  }
};
