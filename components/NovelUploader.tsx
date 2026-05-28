import React, { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel, type Chapter } from '../app/db';
import { useAppStore } from '../app/store';
import { Upload, BookOpen, AlertTriangle, Play, CheckCircle2, AlertCircle, Trash2, Cpu, Loader2 } from 'lucide-react';
import jschardet from 'jschardet';

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const LARGE_FILE_THRESHOLD_BYTES = 20 * 1024 * 1024;
const READ_CHUNK_SIZE_BYTES = 512 * 1024;
const CHAPTER_BULK_SAVE_SIZE = 80;
const DEFAULT_CHAPTER_REGEX = '^\\s*(第\\s*[一二三四五六七八九十百千万零\\d]+\\s*[章节回卷折篇幕].*?)$';

type UploadStage = 'idle' | 'detecting' | 'reading' | 'splitting' | 'saving';

interface StreamImportResult {
  firstChapterId: string | null;
  removedCount: number;
  totalWords: number;
}

interface ChapterAccumulator {
  lineCount: number;
  lines: string[];
  title: string;
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
  '点击下一页', '无广告', '免费阅读', '首发于', '笔趣阁'
];

function formatSizeInMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
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

// Split novel text into chapters
export function splitNovel(text: string, customRegexStr?: string): { title: string; content: string; wordCount: number; chapterIndex: number }[] {
  // Normalize line endings
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Set default pattern or use custom input
  let regex = /^\s*(第\s*[一二三四五六七八九十百千万零\d]+\s*[章节回卷折篇幕].*?)$/gm;
  if (customRegexStr) {
    try {
      regex = new RegExp(customRegexStr, 'gm');
    } catch (err) {
      console.warn('Invalid regex provided, using default pattern', err);
    }
  }
  
  const chapters: { title: string; content: string; wordCount: number; chapterIndex: number }[] = [];
  
  let match;
  const positions: { title: string; index: number }[] = [];
  
  while ((match = regex.exec(normalizedText)) !== null) {
    const title = (match[1] || match[0] || '').trim();
    if (title) {
      positions.push({
        title,
        index: match.index
      });
    }
  }
  
  if (positions.length === 0) {
    // Fallback: treat the whole file as a single chapter
    return [{
      title: '第一章 正文',
      content: normalizedText,
      wordCount: normalizedText.length,
      chapterIndex: 1
    }];
  }
  
  for (let i = 0; i < positions.length; i++) {
    const current = positions[i];
    const next = positions[i + 1];
    const start = current.index;
    const end = next ? next.index : normalizedText.length;
    
    const content = normalizedText.slice(start, end).trim();
    chapters.push({
      title: current.title,
      content: content,
      wordCount: content.length,
      chapterIndex: i + 1
    });
  }
  
  return chapters;
}

// Clean text: removes ads, watermarks, duplicate empty lines, and short promotional paragraphs
export function cleanText(text: string): { cleanedText: string; removedCount: number } {
  const originalLength = text.length;

  // 1. Normalize line endings
  let cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (const pattern of adPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // 3. Line-by-line smart filtering for short promotional paragraphs (under 35 chars)
  const lines = cleaned.split('\n');
  const cleanedLines = lines.map(line => {
    const l = line.trim();
    if (l.length === 0) return '';

    // Suspicious promotional keywords
    const lowerLine = l.toLowerCase();
    if (l.length < 35 && adKeywords.some(kw => lowerLine.includes(kw))) {
      return ''; // Strip this promotional line entirely
    }

    return line; // Keep original line with original indentation
  });

  // 4. Remove consecutive duplicate empty lines
  const finalLines: string[] = [];
  let prevEmpty = false;

  for (const line of cleanedLines) {
    if (line.trim() === '') {
      if (!prevEmpty) {
        finalLines.push('');
        prevEmpty = true;
      }
    } else {
      finalLines.push(line);
      prevEmpty = false;
    }
  }

  const cleanedText = finalLines.join('\n').trim();
  const removedCount = Math.max(0, originalLength - cleanedText.length);

  return { cleanedText, removedCount };
}

export default function NovelUploader() {
  const { 
    llmConfig, 
    selectedNovelId, 
    setSelectedNovelId, 
    selectedChapterId, 
    setSelectedChapterId,
    splitRegexPreset,
    customSplitRegex,
    setSplitRegex
  } = useAppStore();
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadStageText, setUploadStageText] = useState('');
  const [parsingQueue, setParsingQueue] = useState<Record<string, boolean>>({}); // tracking parsing states
  
  // 检索、筛选、分页与分章规则配置状态
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unparsed' | 'parsing' | 'done' | 'error'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [showRegexConfig, setShowRegexConfig] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Live query novels and chapters
  const novels = useLiveQuery<Novel[]>(() => db.novels.reverse().toArray(), []) || [];
  const chapters = useLiveQuery<Chapter[]>(() => {
    if (!selectedNovelId) return [];
    return db.chapters.where('novelId').equals(selectedNovelId).sortBy('chapterIndex');
  }, [selectedNovelId]) || [];

  const activeNovel = novels.find(n => n.id === selectedNovelId);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      await processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      await processFile(e.target.files[0]);
    }
    e.target.value = '';
  };

  const stageLabelMap: Record<UploadStage, string> = {
    idle: '待开始',
    detecting: '检测编码中',
    reading: '读取文本中',
    splitting: '切章处理中',
    saving: '写入本地库中',
  };

  const detectEncoding = async (file: File): Promise<'UTF-8' | 'GB18030' | 'UTF-16LE'> => {
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
      } catch (err) {
        console.warn('Encoding detection failed:', err);
      }

      let normalizedEncoding = encoding.toUpperCase();
      if (
        normalizedEncoding.includes('GB2312') ||
        normalizedEncoding.includes('GBK') ||
        normalizedEncoding.includes('GB18030') ||
        normalizedEncoding.includes('WINDOWS-936')
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

      return normalizedEncoding as 'UTF-8' | 'GB18030' | 'UTF-16LE';
    } catch {
      throw new Error('编码失败：无法检测文本编码');
    }
  };

  const flushChapterBatch = async (batch: Chapter[]): Promise<void> => {
    if (batch.length === 0) return;
    await db.chapters.bulkAdd(batch);
    batch.length = 0;
    await pauseToKeepUiResponsive();
  };

  const readTextWithEncoding = async (file: File, encoding: 'UTF-8' | 'GB18030' | 'UTF-16LE'): Promise<string> => {
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

  const saveSmallFileByWholeParse = async (
    file: File,
    encoding: 'UTF-8' | 'GB18030' | 'UTF-16LE',
    novelId: string,
  ): Promise<StreamImportResult> => {
    setUploadStage('reading');
    setUploadStageText(`正在读取 ${formatSizeInMb(file.size)} 文本...`);
    const text = await readTextWithEncoding(file, encoding);

    setUploadStage('splitting');
    setUploadStageText('正在清洗与切分章节...');
    const { cleanedText, removedCount } = cleanText(text);
    const customRegexForSmallFile = splitRegexPreset === 'custom' ? customSplitRegex : undefined;
    const splitResult = splitNovel(cleanedText, customRegexForSmallFile);

    setUploadStage('saving');
    setUploadStageText(`正在入库 ${splitResult.length} 章...`);
    const chaptersToSave: Chapter[] = splitResult.map((c) => ({
      id: crypto.randomUUID(),
      novelId,
      chapterIndex: c.chapterIndex,
      name: c.title,
      wordCount: c.wordCount,
      content: c.content,
      status: 'unparsed'
    }));
    try {
      await db.chapters.bulkAdd(chaptersToSave);
    } catch (err: any) {
      throw new Error(`入库失败：${err?.message || '章节批量写入失败'}`);
    }

    return {
      firstChapterId: chaptersToSave[0]?.id || null,
      removedCount,
      totalWords: splitResult.reduce((sum, c) => sum + c.wordCount, 0),
    };
  };

  const saveLargeFileByStreaming = async (
    file: File,
    encoding: 'UTF-8' | 'GB18030' | 'UTF-16LE',
    novelId: string,
    chapterTitleRegex: RegExp,
  ): Promise<StreamImportResult> => {
    setUploadStage('reading');
    setUploadStageText(`大文件模式：分块读取 (${formatSizeInMb(file.size)})`);

    const decoder = new TextDecoder(encoding.toLowerCase());
    const chapterBuffer: Chapter[] = [];
    const pendingLines: string[] = [];
    let pendingFragment = '';
    let previousLineWasEmpty = false;
    let currentChapter: ChapterAccumulator | null = null;
    let removedCount = 0;
    let totalWords = 0;
    let chapterIndex = 0;
    let firstChapterId: string | null = null;
    let totalRead = 0;

    const pushLine = (line: string) => {
      const normalizedLine = line.replace(/\r/g, '');
      const { cleanedLine, removedCount: removed } = cleanLine(normalizedLine);
      removedCount += removed;

      const titleMatch = chapterTitleRegex.exec(cleanedLine);
      chapterTitleRegex.lastIndex = 0;
      if (titleMatch) {
        if (currentChapter && currentChapter.lineCount > 0) {
          const chapterContent = currentChapter.lines.join('\n').trim();
          if (chapterContent.length > 0) {
            chapterIndex += 1;
            totalWords += chapterContent.length;
            const chapterId = crypto.randomUUID();
            chapterBuffer.push({
              id: chapterId,
              novelId,
              chapterIndex,
              name: currentChapter.title,
              wordCount: chapterContent.length,
              content: chapterContent,
              status: 'unparsed',
            });
            if (!firstChapterId) {
              firstChapterId = chapterId;
            }
          }
        }

        currentChapter = {
          title: (titleMatch[1] || titleMatch[0] || '').trim() || `第${chapterIndex + 1}章`,
          lines: [cleanedLine],
          lineCount: 1,
        };
        previousLineWasEmpty = cleanedLine.trim() === '';
        return;
      }

      const shouldAppendLine = cleanedLine.trim() !== '' || !previousLineWasEmpty;
      if (!currentChapter) {
        currentChapter = {
          title: '第一章 正文',
          lines: [],
          lineCount: 0,
        };
      }
      if (shouldAppendLine) {
        currentChapter.lines.push(cleanedLine);
        currentChapter.lineCount += 1;
      }
      previousLineWasEmpty = cleanedLine.trim() === '';
    };

    const flushLines = async (isFinal: boolean) => {
      for (let i = 0; i < pendingLines.length; i++) {
        pushLine(pendingLines[i]);
      }
      pendingLines.length = 0;

      if (isFinal) {
        if (pendingFragment.length > 0) {
          pushLine(pendingFragment);
          pendingFragment = '';
        }
        if (currentChapter && currentChapter.lineCount > 0) {
          const chapterContent = currentChapter.lines.join('\n').trim();
          if (chapterContent.length > 0) {
            chapterIndex += 1;
            totalWords += chapterContent.length;
            const chapterId = crypto.randomUUID();
            chapterBuffer.push({
              id: chapterId,
              novelId,
              chapterIndex,
              name: currentChapter.title,
              wordCount: chapterContent.length,
              content: chapterContent,
              status: 'unparsed',
            });
            if (!firstChapterId) {
              firstChapterId = chapterId;
            }
          }
        }
      }

      if (chapterBuffer.length >= CHAPTER_BULK_SAVE_SIZE || (isFinal && chapterBuffer.length > 0)) {
        setUploadStage('saving');
        setUploadStageText(`大文件模式：已切分 ${chapterIndex} 章，分批入库中...`);
        try {
          await flushChapterBatch(chapterBuffer);
        } catch (err: any) {
          throw new Error(`入库失败：${err?.message || '章节分批写入失败'}`);
        }
      }
    };

    for (let offset = 0; offset < file.size; offset += READ_CHUNK_SIZE_BYTES) {
      const chunk = file.slice(offset, offset + READ_CHUNK_SIZE_BYTES);
      const bytes = new Uint8Array(await readBlobAsArrayBuffer(chunk));
      totalRead += bytes.byteLength;
      setUploadStage('reading');
      setUploadStageText(`分块读取进度：${Math.min(100, Math.floor((totalRead / file.size) * 100))}%`);

      const decodedText = decoder.decode(bytes, { stream: true });
      pendingFragment += decodedText;
      const splitByLine = pendingFragment.split('\n');
      pendingFragment = splitByLine.pop() ?? '';
      pendingLines.push(...splitByLine);

      setUploadStage('splitting');
      setUploadStageText(`正在切章：已处理 ${formatSizeInMb(totalRead)} / ${formatSizeInMb(file.size)}`);
      await flushLines(false);
    }

    pendingFragment += decoder.decode();
    await flushLines(true);

    if (chapterIndex === 0) {
      throw new Error('分章失败：没有解析到有效章节内容');
    }

    return {
      firstChapterId,
      removedCount,
      totalWords,
    };
  };

  const processFile = async (file: File) => {
    if (uploading) {
      return;
    }
    if (!file.name.toLowerCase().endsWith('.txt')) {
      setErrorMsg('只支持上传 .txt 格式的小说文本');
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      setErrorMsg(`文件过大，最大支持 ${MAX_UPLOAD_SIZE_MB}MB`);
      return;
    }

    const isLargeFileMode = file.size > LARGE_FILE_THRESHOLD_BYTES;
    if (isLargeFileMode && splitRegexPreset === 'custom') {
      if (!customSplitRegex.trim()) {
        setErrorMsg('请先填写有效的自定义分章正则表达式');
        return;
      }
      const lineRegexValidationError = validateLineRegex(customSplitRegex);
      if (lineRegexValidationError) {
        setErrorMsg(lineRegexValidationError);
        return;
      }
    }

    setUploading(true);
    setUploadStage('detecting');
    setUploadStageText('正在检测编码...');
    setErrorMsg(null);

    const novelId = crypto.randomUUID();
    const novelName = file.name.replace(/\.[^/.]+$/, "");

    try {
      const encoding = await detectEncoding(file);

      let importResult: StreamImportResult;
      if (isLargeFileMode) {
        let chapterTitleRegex: RegExp;
        try {
          chapterTitleRegex = splitRegexPreset === 'custom'
            ? toLineRegex(customSplitRegex)
            : toLineRegex(DEFAULT_CHAPTER_REGEX);
        } catch {
          throw new Error('分章失败：自定义分章正则表达式无效');
        }
        importResult = await saveLargeFileByStreaming(file, encoding, novelId, chapterTitleRegex);
      } else {
        importResult = await saveSmallFileByWholeParse(file, encoding, novelId);
      }

      // Save novel to db
      await db.novels.add({
        id: novelId,
        name: novelName,
        wordCount: importResult.totalWords,
        createdAt: Date.now(),
        purifiedCount: importResult.removedCount
      });
      
      setSelectedNovelId(novelId);
      if (importResult.firstChapterId) {
        setSelectedChapterId(importResult.firstChapterId);
      }
    } catch (err: any) {
      await db.chapters.where('novelId').equals(novelId).delete();
      await db.novels.delete(novelId);
      setErrorMsg(err?.message || '文件解析入库失败');
    } finally {
      setUploading(false);
      setUploadStage('idle');
      setUploadStageText('');
    }
  };

  const deleteNovel = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确认删除这部小说及其所有章节解析吗？')) return;
    
    await db.novels.delete(id);
    await db.chapters.where('novelId').equals(id).delete();
    
    if (selectedNovelId === id) {
      setSelectedNovelId(null);
      setSelectedChapterId(null);
    }
  };

  // Parse a single chapter using LLM
  const parseChapter = async (chapter: Chapter) => {
    if (!llmConfig.apiKey) {
      alert('请先配置大模型 API Key！(在右上角设置面板)');
      return;
    }

    setParsingQueue((prev) => ({ ...prev, [chapter.id]: true }));
    await db.chapters.update(chapter.id, { status: 'parsing', errorMsg: undefined });

    try {
      const response = await fetch('/api/py/parse-chapter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: chapter.name,
          content: chapter.content.slice(0, 15000), // Limit tokens for parsing
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
        analysis: analysis
      });
    } catch (err: any) {
      console.error(err);
      await db.chapters.update(chapter.id, {
        status: 'error',
        errorMsg: err.message || '大模型解析出错'
      });
    } finally {
      setParsingQueue((prev) => ({ ...prev, [chapter.id]: false }));
    }
  };

  // Parallel parsing queue scheduler (Max concurrency = 3)
  const parseAllChapters = async () => {
    if (!llmConfig.apiKey) {
      alert('请先配置大模型 API Key！');
      return;
    }

    const unparsedChapters = chapters.filter(c => c.status !== 'done');
    if (unparsedChapters.length === 0) {
      alert('所有章节都已解析完毕！');
      return;
    }

    if (!confirm(`准备解析 ${unparsedChapters.length} 个章节，由于调用大模型可能产生流量和延迟，确定一键解析吗？`)) return;

    const concurrencyLimit = 3;
    let index = 0;

    const worker = async () => {
      while (index < unparsedChapters.length) {
        const currentIdx = index++;
        const chapter = unparsedChapters[currentIdx];
        await parseChapter(chapter);
      }
    };

    // Spawn 3 concurrent workers
    const workers = [];
    for (let i = 0; i < Math.min(concurrencyLimit, unparsedChapters.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
  };

  // 动态检索、筛选与分页计算
  const filteredChapters = chapters.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const pageSize = 12;
  const totalPages = Math.ceil(filteredChapters.length / pageSize) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const paginatedChapters = filteredChapters.slice(startIndex, startIndex + pageSize);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-auto lg:h-[calc(100vh-12rem)] min-h-0">
      
      {/* Left Column: Novel Library */}
      <div className="lg:col-span-1 bg-zinc-900/20 border border-zinc-800/80 rounded-2xl p-4 flex flex-col shadow-xl min-h-0">
        <h3 className="text-sm font-bold text-zinc-400 mb-3 px-1 uppercase tracking-wider">小说创意库</h3>
        
        {/* Upload Button Trigger */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full py-3 mb-2 rounded-xl border border-dashed border-zinc-750 hover:border-zinc-550 bg-zinc-900/40 hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 font-semibold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Upload className="w-4 h-4" />
          导入新小说 (.txt, 最大 {MAX_UPLOAD_SIZE_MB}MB)
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".txt"
          className="hidden"
        />
        {uploading && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-zinc-900/70 border border-zinc-800 text-zinc-300 text-[11px] flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
            <span>{stageLabelMap[uploadStage]}{uploadStageText ? `：${uploadStageText}` : ''}</span>
          </div>
        )}
        {!uploading && errorMsg && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[11px] flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* 高级分章规则面板折叠开关 */}
        <button
          onClick={() => setShowRegexConfig(!showRegexConfig)}
          className="w-full text-left px-2.5 py-2 mb-4 text-[10px] text-zinc-400 hover:text-zinc-200 transition-colors flex items-center justify-between border border-zinc-800/50 rounded-xl bg-zinc-950/20"
        >
          <span className="font-semibold">⚙️ 高级分章规则配置</span>
          <span className="font-mono text-zinc-500">{showRegexConfig ? '收起 ▲' : '展开 ▼'}</span>
        </button>

        {/* 分章正则配置面板主体 */}
        {showRegexConfig && (
          <div className="p-3 mb-4 rounded-xl border border-zinc-850 bg-zinc-950/50 text-xs space-y-3 animate-fade-in">
            <div>
              <label className="text-[10px] text-zinc-500 font-bold block mb-1">规则预设类型</label>
              <select
                value={splitRegexPreset}
                onChange={(e) => {
                  const val = e.target.value as 'chinese' | 'english' | 'custom';
                  let regex = '';
                  if (val === 'chinese') {
                    regex = '^\\s*(第\\s*[一二三四五六七八九十百千万零\\d]+\\s*[章节回卷折篇幕].*?)$';
                  } else if (val === 'english') {
                    regex = '^\\s*(Chapter\\s*\\d+.*?)$';
                  } else {
                    regex = customSplitRegex;
                  }
                  setSplitRegex(val, regex);
                }}
                className="w-full px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 focus:outline-none text-[11px]"
              >
                <option value="chinese">标准中文 (第X章/第X回)</option>
                <option value="english">标准英文 (Chapter \d+)</option>
                <option value="custom">自定义正则表达式</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 font-bold block mb-1">分章匹配正则表达式</label>
              <input
                type="text"
                value={customSplitRegex}
                disabled={splitRegexPreset !== 'custom'}
                onChange={(e) => setSplitRegex('custom', e.target.value)}
                placeholder="例如: ^\\s*(第\\s*[\\d]+\\s*章.*?)$"
                className="w-full px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 font-mono text-[10px] focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>
        )}

        {/* Novel List */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {novels.length === 0 ? (
            <div className="text-center py-8 text-zinc-600 text-xs">
              暂无小说，请先导入
            </div>
          ) : (
            novels.map((n) => (
              <div
                key={n.id}
                onClick={() => {
                  setSelectedNovelId(n.id);
                  setCurrentPage(1);
                  setSearchQuery('');
                  setStatusFilter('all');
                }}
                className={`group p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                  selectedNovelId === n.id
                    ? 'bg-zinc-800/80 border-zinc-700 text-zinc-100'
                    : 'bg-zinc-950/20 border-zinc-900/80 hover:border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <BookOpen className={`w-4 h-4 flex-shrink-0 ${selectedNovelId === n.id ? 'text-zinc-300' : 'text-zinc-500'}`} />
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{n.name}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5 font-mono">
                      {(n.wordCount / 10000).toFixed(1)}万字
                    </p>
                  </div>
                </div>
                <button
                  onClick={(e) => deleteNovel(n.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/10 text-zinc-500 hover:text-red-400 rounded transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Middle & Right Column: Chapters & Parsing Interface */}
      <div className="lg:col-span-3 bg-zinc-900/20 border border-zinc-800/80 rounded-2xl p-6 flex flex-col shadow-xl min-h-0">
        
        {/* If no novel is selected */}
        {!selectedNovelId ? (
          <div 
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            className={`flex-1 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center p-8 transition-all ${
              dragActive 
                ? 'border-zinc-500 bg-zinc-900/30' 
                : 'border-zinc-800 hover:border-zinc-700 bg-zinc-950/20'
            }`}
          >
            <div className="p-4 rounded-full bg-zinc-900/60 border border-zinc-800 text-zinc-400 mb-4">
              <Upload className="w-8 h-8" />
            </div>
            <h4 className="text-base font-bold text-zinc-200">拖拽上传小说文本</h4>
            <p className="text-xs text-zinc-500 mt-2 text-center max-w-sm leading-relaxed">
              支持上传标准的 `.txt` 格式网文小说（最大 {MAX_UPLOAD_SIZE_MB}MB），系统将通过字节流自动识别 UTF-8 / GBK 编码防止乱码，并按章节自动切分。
            </p>
            {errorMsg && (
              <div className="mt-4 px-4 py-2 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-lg flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                {errorMsg}
              </div>
            )}
          </div>
        ) : (
          /* Chapters view */
          <div className="flex-1 flex flex-col min-h-0">
            {/* Header info */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-zinc-800 gap-3">
              <div>
                <h2 className="text-lg font-bold text-zinc-200">
                  章节列表与结构化解析
                </h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  已分割 {chapters.length} 个章节。章节在生成融合小说前，需先进行大模型特征解析。
                </p>
              </div>
              
              <button
                onClick={parseAllChapters}
                className="py-2.5 px-4 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded-xl text-xs font-semibold shadow-sm flex items-center justify-center gap-2 transition-all"
              >
                <Cpu className="w-3.5 h-3.5" />
                一键解析全部章节
              </button>
            </div>

            {/* Smart Search & Status Filters */}
            <div className="mt-4 flex flex-col md:flex-row gap-3 items-center justify-between bg-zinc-950/20 border border-zinc-850 p-3 rounded-2xl">
              {/* Search bar */}
              <div className="relative w-full md:w-64">
                <input
                  type="text"
                  placeholder="🔍 搜索章节名称..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full pl-3 pr-8 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-650 focus:outline-none focus:ring-1 focus:ring-zinc-700 font-medium"
                />
                {searchQuery && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setCurrentPage(1);
                    }}
                    className="absolute right-2.5 top-1.5 text-zinc-500 hover:text-zinc-300 text-sm font-bold"
                  >
                    ×
                  </button>
                )}
              </div>

              {/* Status Filters */}
              <div className="flex items-center gap-1.5 overflow-x-auto w-full md:w-auto pb-1 md:pb-0 scrollbar-none">
                {(['all', 'unparsed', 'done', 'error'] as const).map((status) => {
                  const count = chapters.filter(c => status === 'all' || c.status === status).length;
                  const label = status === 'all' ? '全部' : status === 'unparsed' ? '待解析' : status === 'done' ? '已解析' : '解析失败';
                  const active = statusFilter === status;
                  return (
                    <button
                      key={status}
                      onClick={() => {
                        setStatusFilter(status);
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all whitespace-nowrap border ${
                        active
                          ? 'bg-zinc-800 text-zinc-200 border-zinc-650 shadow-sm'
                          : 'bg-zinc-950/40 text-zinc-500 hover:text-zinc-300 border-zinc-900 hover:border-zinc-800'
                      }`}
                    >
                      {label} ({count})
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Smart purification notification bar */}
            {activeNovel && activeNovel.purifiedCount !== undefined && activeNovel.purifiedCount > 0 && (
              <div className="mt-3 px-4 py-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800 text-zinc-300 text-xs flex items-center gap-2 animate-fade-in">
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-zinc-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-zinc-400"></span>
                </span>
                <span className="flex items-center gap-1 flex-wrap">
                  <BookOpen className="w-3.5 h-3.5 text-zinc-400" />
                  <span>
                    <strong>智能净化已生效</strong>：已为您过滤广告、推广链接、冗余空行及乱码字符共 <strong className="text-zinc-100 font-mono">{activeNovel.purifiedCount}</strong> 个字符。
                  </span>
                </span>
              </div>
            )}

            {/* Chapters list table */}
            <div className="flex-1 overflow-y-auto mt-4 pr-1">
              {paginatedChapters.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-20 text-zinc-500">
                  <p className="text-sm font-semibold">没有找到匹配的章节</p>
                  <p className="text-xs text-zinc-600 mt-1">请尝试修改搜索词或状态筛选条件</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {paginatedChapters.map((c) => {
                    const isParsing = parsingQueue[c.id] || c.status === 'parsing';
                    const isSelected = selectedChapterId === c.id;
                    
                    return (
                      <div
                        key={c.id}
                        onClick={() => setSelectedChapterId(c.id)}
                        className={`p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between h-32 ${
                          isSelected
                            ? 'bg-zinc-800/40 border-zinc-650 text-zinc-100 shadow-sm'
                            : 'bg-zinc-950/20 border-zinc-800/60 hover:border-zinc-700/80 text-zinc-450'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs text-zinc-500 font-mono">Chapter {c.chapterIndex}</p>
                            <h4 className="font-semibold text-sm text-zinc-200 truncate mt-1">{c.name}</h4>
                            <p className="text-[10px] text-zinc-500 font-mono mt-0.5">{c.wordCount} 字</p>
                          </div>

                          {/* Status tag */}
                          <div>
                            {c.status === 'done' && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                                <CheckCircle2 className="w-3 h-3 text-zinc-400" />
                                已解析
                              </span>
                            )}
                            {c.status === 'unparsed' && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800/80 text-zinc-500">
                                待解析
                              </span>
                            )}
                            {isParsing && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-700 text-zinc-300">
                                <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                                解析中
                              </span>
                            )}
                            {c.status === 'error' && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-red-950/20 border border-red-900/30 text-red-400">
                                <AlertCircle className="w-3 h-3" />
                                解析失败
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between border-t border-zinc-800/80 pt-2 mt-2">
                          {/* Error info or status explanation */}
                          <div className="min-w-0 flex-1">
                            {c.status === 'error' ? (
                              <p className="text-[10px] text-red-400 truncate pr-2">{c.errorMsg || '解析出错'}</p>
                            ) : c.status === 'done' ? (
                              <p className="text-[10px] text-zinc-400 truncate pr-2">角色: {c.analysis?.characters.length} | 关系: {c.analysis?.relationships.length}</p>
                            ) : (
                              <p className="text-[10px] text-zinc-650 truncate pr-2">暂无可用角色骨架分析</p>
                            )}
                          </div>

                          {/* Control buttons */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              parseChapter(c);
                            }}
                            disabled={isParsing}
                            className="py-1 px-2.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 text-[11px] font-medium flex items-center gap-1 transition-all disabled:opacity-50"
                          >
                            <Play className="w-3 h-3" />
                            {c.status === 'done' ? '重新解析' : '开始解析'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-zinc-800/80 pt-4 mt-6">
                <span className="text-[10px] text-zinc-500 font-mono">
                  第 {safePage} 页 / 共 {totalPages} 页 (共 {filteredChapters.length} 章)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                    disabled={safePage === 1}
                    className="py-1 px-3 rounded bg-zinc-950 border border-zinc-800 hover:bg-zinc-900 text-zinc-400 text-xs disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  >
                    ◀ 上一页
                  </button>
                  <button
                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                    disabled={safePage === totalPages}
                    className="py-1 px-3 rounded bg-zinc-950 border border-zinc-800 hover:bg-zinc-900 text-zinc-400 text-xs disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  >
                    下一页 ▶
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
