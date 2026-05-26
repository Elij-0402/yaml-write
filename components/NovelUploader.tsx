import React, { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel, type Chapter } from '../app/db';
import { useAppStore } from '../app/store';
import { Upload, BookOpen, AlertTriangle, FileText, Play, CheckCircle2, AlertCircle, Trash2, Cpu, Loader2, Sparkles } from 'lucide-react';
import jschardet from 'jschardet';

// Split novel text into chapters
export function splitNovel(text: string): { title: string; content: string; wordCount: number; chapterIndex: number }[] {
  // Normalize line endings
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Match 第 X 章, 第 X 节, 第 X 回 etc at the start of a line
  const regex = /^\s*(第\s*[一二三四五六七八九十百千万零\d]+\s*[章节回卷折篇幕].*?)$/gm;
  const chapters: { title: string; content: string; wordCount: number; chapterIndex: number }[] = [];
  
  let match;
  const positions: { title: string; index: number }[] = [];
  
  while ((match = regex.exec(normalizedText)) !== null) {
    positions.push({
      title: match[1].trim(),
      index: match.index
    });
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

  // 2. High-frequency advertising watermarks, websites, and junk symbols
  const adPatterns = [
    // Web domains and URLs
    /(https?:\/\/[^\s]+)/gi,
    /[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\.?(:\d+)?(\/\S*)*/gi,

    // Common pirate site watermarks
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

    // Punctuation noise and OCR garbage
    /&nbsp;/g,
    /&lt;/g,
    /&gt;/g,
    /&amp;/g,
  ];

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
    const adKeywords = [
      '下载app', '最新域名', '官方微信', '关注公众号', '加入书签',
      '手机阅读', '点击下载', '投月票', '收藏本书', '安卓版', '苹果版',
      '点击下一页', '无广告', '免费阅读', '首发于', '笔趣阁'
    ];

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
  const { llmConfig, selectedNovelId, setSelectedNovelId, selectedChapterId, setSelectedChapterId } = useAppStore();
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [parsingQueue, setParsingQueue] = useState<Record<string, boolean>>({}); // tracking parsing states

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
  };

  const processFile = async (file: File) => {
    if (!file.name.endsWith('.txt')) {
      setErrorMsg('只支持上传 .txt 格式的小说文本');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErrorMsg('文件过大，最大支持 10MB');
      return;
    }

    setUploading(true);
    setErrorMsg(null);

    try {
      const text = await readTextWithEncodingCheck(file);
      const { cleanedText, removedCount } = cleanText(text);
      const splitted = splitNovel(cleanedText);
      
      const novelId = crypto.randomUUID();
      const novelName = file.name.replace(/\.[^/.]+$/, "");
      const totalWords = splitted.reduce((sum, c) => sum + c.wordCount, 0);

      // Save novel to db
      await db.novels.add({
        id: novelId,
        name: novelName,
        wordCount: totalWords,
        createdAt: Date.now(),
        purifiedCount: removedCount
      });

      // Save chapters to db
      const chaptersToSave: Chapter[] = splitted.map((c) => ({
        id: crypto.randomUUID(),
        novelId,
        chapterIndex: c.chapterIndex,
        name: c.title,
        wordCount: c.wordCount,
        content: c.content,
        status: 'unparsed'
      }));

      await db.chapters.bulkAdd(chaptersToSave);
      
      setSelectedNovelId(novelId);
      if (chaptersToSave.length > 0) {
        setSelectedChapterId(chaptersToSave[0].id);
      }
    } catch (err: any) {
      setErrorMsg(err.message || '文件解析入库失败');
    } finally {
      setUploading(false);
    }
  };

  const readTextWithEncodingCheck = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (!e.target?.result) {
          reject(new Error('无法读取文件'));
          return;
        }

        const buffer = e.target.result as ArrayBuffer;
        const arr = new Uint8Array(buffer);
        const detectLength = Math.min(arr.length, 50000);
        const slice = arr.slice(0, detectLength);

        let binaryStr = '';
        for (let i = 0; i < slice.length; i++) {
          binaryStr += String.fromCharCode(slice[i]);
        }

        let encoding = 'UTF-8';
        try {
          const result = jschardet.detect(binaryStr);
          if (result && result.encoding) {
            encoding = result.encoding;
          }
        } catch (err) {
          console.warn('Encoding detection failed:', err);
        }

        let normalizedEncoding = encoding.toUpperCase();
        if (normalizedEncoding.includes('GB2312') || normalizedEncoding.includes('GBK') || normalizedEncoding.includes('GB18030') || normalizedEncoding.includes('WINDOWS-936')) {
          normalizedEncoding = 'GB18030';
        } else if (normalizedEncoding.includes('UTF-8') || normalizedEncoding.includes('ASCII')) {
          normalizedEncoding = 'UTF-8';
        } else if (normalizedEncoding.includes('UTF-16')) {
          normalizedEncoding = 'UTF-16LE';
        } else {
          normalizedEncoding = 'GB18030'; // Default to GB18030 for Chinese
        }

        const textReader = new FileReader();
        textReader.onload = (ev) => {
          const text = ev.target?.result as string;
          const replacementCharCount = (text.match(/\ufffd/g) || []).length;
          const replacementRatio = replacementCharCount / (text.length || 1);

          if (normalizedEncoding === 'UTF-8' && replacementRatio > 0.01) {
            console.warn('UTF-8 has high replacement ratio, falling back to GB18030');
            const fallbackReader = new FileReader();
            fallbackReader.onload = (eve) => {
              resolve(eve.target?.result as string);
            };
            fallbackReader.onerror = () => reject(new Error('文件解码失败'));
            fallbackReader.readAsText(file, 'GB18030');
          } else {
            resolve(text);
          }
        };
        textReader.onerror = () => reject(new Error('文本解析失败'));
        textReader.readAsText(file, normalizedEncoding);
      };
      reader.onerror = () => reject(new Error('二进制流读取失败'));
      reader.readAsArrayBuffer(file);
    });
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-auto lg:h-[calc(100vh-12rem)] min-h-0">
      
      {/* Left Column: Novel Library */}
      <div className="lg:col-span-1 bg-zinc-900/20 border border-zinc-800/80 rounded-2xl p-4 flex flex-col shadow-xl min-h-0">
        <h3 className="text-sm font-bold text-zinc-400 mb-3 px-1 uppercase tracking-wider">小说创意库</h3>
        
        {/* Upload Button Trigger */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full py-3 mb-4 rounded-xl border border-dashed border-zinc-750 hover:border-zinc-550 bg-zinc-900/40 hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 font-semibold text-sm transition-all flex items-center justify-center gap-2"
        >
          <Upload className="w-4 h-4" />
          导入新小说 (.txt)
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".txt"
          className="hidden"
        />

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
                onClick={() => setSelectedNovelId(n.id)}
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
              支持上传标准的 `.txt` 格式网文小说，系统将通过字节流自动识别 UTF-8 / GBK 编码防止乱码，并按章节自动切分。
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {chapters.map((c) => {
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
