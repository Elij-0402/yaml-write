import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel, type SplitMeta, type SplitStrategyId } from '../app/db';
import { useAppStore } from '../app/store';
import { listProviderMetas, getProviderMeta } from '../app/llmProviders';
import { getLlmConfigError, postWithLlmConfig, readApiErrorMessage } from '../app/llmClient';
import { runDnaExtraction } from '../app/dnaEngine';

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const DEFAULT_CUSTOM_REGEX = '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';
const MAX_CUSTOM_REGEX_LENGTH = 300;

// === Story 1.6: JIT 智能语义拆分 / Ollama 心跳 ===
const SMART_SPLIT_MIN_WORDS = 8000; // 分章置信度极低判定：分章数 <= 1 且总字数 >= 此阈值
const SMART_SPLIT_MAX_CHARS = 20000; // 发往后端的正文上限（前两万字）
const COMPATIBLE_MODEL_REGEX = /llama3|qwen2\.5|qwen2/i; // Ollama 兼容模型静默审计
const OLLAMA_OFFLINE_HINT =
  '检测到本地 AI 处于星体静思中，请确保您的 Ollama 已经开启，或者可在上方粘贴您的云端水晶 Key 🔑';
const OLLAMA_MODEL_MISSING_HINT =
  'Ollama 已在线，但未检测到兼容的 llama3 或 qwen2.5 模型。建议在控制台运行 `ollama run qwen2.5` 一键拉取，或可在上方使用云端大模型。';

type OllamaStatus = 'unknown' | 'checking' | 'online' | 'offline' | 'model_missing';

// Mirrors api/schemas.py SplitRecommendation (camelCase) — duplicated-shape convention.
interface SplitRecommendation {
  splitParagraphIndex: number;
  suggestedTitle: string;
  reason: string;
}

type UploadStage = 'idle' | 'detecting' | 'reading' | 'splitting' | 'hashing' | 'saving';

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`;
  return `${count}`;
}

function toLineRegex(pattern: string): RegExp {
  if (!pattern.trim()) throw new Error('empty regex pattern');
  const inputRegex = new RegExp(pattern, 'm');
  const safeFlags = inputRegex.flags.replace('g', '').replace('y', '');
  return new RegExp(inputRegex.source, safeFlags);
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

async function computeSha256(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

export default function NovelUploader() {
  const { selectedNovelId, setSelectedNovelId, setManageMode, llmConfig, setActiveProvider, updateActiveProviderProfile } =
    useAppStore();
  const activeProvider = llmConfig.activeProvider;
  const activeProviderMeta = getProviderMeta(activeProvider);
  const activeProfile = llmConfig.providerProfiles[activeProvider];

  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadStageText, setUploadStageText] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [repairStrategy, setRepairStrategy] = useState<SplitStrategyId>('zh_extended');
  const [repairRegex, setRepairRegex] = useState(DEFAULT_CUSTOM_REGEX);
  const [repairing, setRepairing] = useState(false);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [selectedChapterIds, setSelectedChapterIds] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [localExtractingMap, setLocalExtractingMap] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{
    show: boolean;
    message: string;
    countdown: number;
    type?: 'stitch' | 'success';
  } | null>(null);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [canUndo, setCanUndo] = useState(false);

  // Story 1.5 State
  const [isSplitMode, setIsSplitMode] = useState(false);
  const [hoveredGapIndex, setHoveredGapIndex] = useState<number | null>(null);
  const [selectedMobileGapIndex, setSelectedMobileGapIndex] = useState<number | null>(null);
  const [isTearing, setIsTearing] = useState(false);
  const [splittingIndex, setSplittingIndex] = useState<number | null>(null);

  // Story 1.6 State — JIT 水晶配置卡 + Ollama 心跳 + 智能语义拆分推荐
  const [isCrystalOpen, setIsCrystalOpen] = useState(false);
  const [showCrystalKey, setShowCrystalKey] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>('unknown');
  const [ollamaMessage, setOllamaMessage] = useState('');
  const [splitRecommendations, setSplitRecommendations] = useState<SplitRecommendation[]>([]);
  const [smartSplitLoading, setSmartSplitLoading] = useState(false);

  useEffect(() => {
    setActiveChapterId(null);
    setSelectedChapterIds(new Set());
    setIsSplitMode(false);
    setHoveredGapIndex(null);
    setSelectedMobileGapIndex(null);
    setIsTearing(false);
    setSplittingIndex(null);
    setIsCrystalOpen(false);
    setSplitRecommendations([]);
    setLocalExtractingMap({});
  }, [selectedNovelId]);

  useEffect(() => {
    setIsSplitMode(false);
    setHoveredGapIndex(null);
    setSelectedMobileGapIndex(null);
    setIsTearing(false);
    setSplittingIndex(null);
    setSplitRecommendations([]);
  }, [activeChapterId]);



  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeWorkerRef = useRef<Worker | null>(null);
  const activeWatchdogRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (activeWorkerRef.current) {
        activeWorkerRef.current.terminate();
        activeWorkerRef.current = null;
      }
      if (activeWatchdogRef.current) {
        clearTimeout(activeWatchdogRef.current);
        activeWatchdogRef.current = null;
      }
    };
  }, []);

  const novels = useLiveQuery<Novel[]>(() => db.novels.reverse().toArray(), []) || [];
  const chaptersQuery = useLiveQuery<Chapter[]>(() => {
    if (!selectedNovelId) return [];
    return db.chapters.where('novelId').equals(selectedNovelId).sortBy('chapterIndex');
  }, [selectedNovelId]);
  const chapters = useMemo(() => chaptersQuery || [], [chaptersQuery]);
  const activeNovel = novels.find((n) => n.id === selectedNovelId) || null;

  const activeChapter = useMemo(() => {
    if (!activeChapterId) return null;
    return chapters.find((c) => c.id === activeChapterId) || null;
  }, [chapters, activeChapterId]);

  const derivedStats = useMemo(() => {
    if (chapters.length === 0) return null;
    const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0);
    return { chapterCount: chapters.length, avgChapterChars: totalWords / chapters.length };
  }, [chapters]);

  const needsSmartRepair = activeNovel?.splitStatus === 'needs_review';
  const splitMeta = activeNovel?.splitMeta;
  const reviewReasons = splitMeta?.reviewReasons || [];

  // Story 1.6 derived — 智能语义拆分入口判定 / 水晶卡就绪态 / 推荐点索引
  const oversizedChapter = chapters.find((c) => c.wordCount > 30000) || null;
  const canSmartSplit =
    chapters.length >= 1 &&
    (
      ((derivedStats?.chapterCount ?? 0) <= 1 && (activeNovel?.wordCount ?? 0) >= SMART_SPLIT_MIN_WORDS) ||
      Boolean(oversizedChapter)
    );
  const ollamaReachable = ollamaStatus === 'online' || ollamaStatus === 'model_missing';
  const crystalReady = activeProviderMeta.requiresApiKey ? activeProfile.apiKey.trim().length > 0 : ollamaReachable;
  const recByIndex = useMemo(() => {
    const map: Record<number, SplitRecommendation> = {};
    splitRecommendations.forEach((r) => {
      map[r.splitParagraphIndex] = r;
    });
    return map;
  }, [splitRecommendations]);

  // T3/T4: Ollama 5s 静默心跳 + 1.5s 极限超时熔断 + /api/tags 模型静默审计。
  // 仅在水晶卡打开且选用 Ollama 时轮询，避免无谓的后台请求。
  const ollamaBaseUrl = llmConfig.providerProfiles.ollama.baseUrl;
  useEffect(() => {
    if (!isCrystalOpen || activeProvider !== 'ollama') {
      setOllamaStatus('unknown');
      setOllamaMessage('');
      return;
    }

    let cancelled = false;
    const origin = (ollamaBaseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
    const tagsUrl = `${origin}/api/tags`;

    const beat = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500); // 1.5s 死线熔断
      try {
        const res = await fetch(tagsUrl, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { models?: Array<{ model?: string; name?: string }> };
        clearTimeout(timer);
        const names = (data.models || []).map((m) => String(m?.model || m?.name || '')).filter(Boolean);
        const matched = names.find((n) => COMPATIBLE_MODEL_REGEX.test(n));
        if (cancelled) return;
        if (matched) {
          setOllamaStatus('online');
          setOllamaMessage(`已就绪：检测到兼容模型 ${matched}`);
        } else {
          setOllamaStatus('model_missing');
          setOllamaMessage(OLLAMA_MODEL_MISSING_HINT);
        }
      } catch {
        clearTimeout(timer);
        if (cancelled) return;
        setOllamaStatus('offline');
        setOllamaMessage(OLLAMA_OFFLINE_HINT);
      }
    };

    setOllamaStatus('checking');
    void beat();
    const intervalId = setInterval(() => void beat(), 5000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isCrystalOpen, activeProvider, ollamaBaseUrl]);

  const resetChapterListView = () => { setSearchQuery(''); setActiveChapterId(null); };

  const backupStitchData = (novelId: string, affectedChapters: Chapter[]): boolean => {
    const tocMap: Record<string, number> = {};
    chapters.forEach((c) => {
      tocMap[c.id] = c.chapterIndex;
    });

    const clonedAffected = affectedChapters.map((c) => ({
      id: c.id,
      novelId: c.novelId,
      chapterIndex: c.chapterIndex,
      name: c.name,
      content: c.content,
      wordCount: c.wordCount,
      contentSha256: c.contentSha256,
      status: c.status,
      mapStatus: c.mapStatus,
    }));

    const backup = {
      novelId,
      affectedChapters: clonedAffected,
      tocMap,
    };

    const jsonStr = JSON.stringify(backup);
    if (jsonStr.length > 4 * 1024 * 1024) {
      console.warn('Backup data is too large (>4MB) for localStorage. Disabling Undo to prevent storage failure.');
      return false;
    }

    try {
      localStorage.setItem('bmad_stitch_backup', jsonStr);
      return true;
    } catch (e) {
      console.warn('LocalStorage backup failed (QuotaExceededError or security restrictions), skipping backup:', e);
      return false;
    }
  };

  const handleStitch = async (chapterId: string) => {
    if (processing || !selectedNovelId) return;

    const currIdx = chapters.findIndex((c) => c.id === chapterId);
    if (currIdx <= 0) return;

    const curr = chapters[currIdx];
    const prev = chapters[currIdx - 1];

    setProcessing(true);

    try {
      setCanUndo(backupStitchData(selectedNovelId, [prev, curr]));

      await new Promise((resolve) => setTimeout(resolve, 200));

      const mergedContent = prev.content + '\n\n' + curr.content;
      const sha = await computeSha256(mergedContent);

      await db.transaction('rw', [db.chapters, db.novels], async () => {
        const dbPrev = await db.chapters.get(prev.id);
        const dbCurr = await db.chapters.get(curr.id);
        if (!dbPrev || !dbCurr) return;

        await db.chapters.update(prev.id, {
          content: mergedContent,
          wordCount: mergedContent.length,
          contentSha256: sha,
          mapStatus: 'pending'
        });

        await db.chapters.delete(curr.id);

        const subsequent = await db.chapters
          .where('novelId')
          .equals(selectedNovelId)
          .filter((c) => c.chapterIndex > dbCurr.chapterIndex)
          .toArray();

        for (const sub of subsequent) {
          await db.chapters.update(sub.id, {
            chapterIndex: sub.chapterIndex - 1,
          });
        }

        const updatedChapters = await db.chapters.where('novelId').equals(selectedNovelId).toArray();
        await db.novels.update(selectedNovelId, {
          wordCount: updatedChapters.reduce((sum, c) => sum + c.wordCount, 0),
        });
      });

      setSelectedChapterIds(new Set());

      if (activeChapterId === curr.id) {
        setActiveChapterId(prev.id);
      }

      setToast({
        show: true,
        message: `已将章节【${curr.name}】合并至上一章`,
        countdown: 6000,
        type: 'stitch',
      });

    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : '缝合操作失败');
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300));
      setProcessing(false);
    }
  };

  const handleUndo = async () => {
    if (processing || !selectedNovelId) return;

    const backupStr = localStorage.getItem('bmad_stitch_backup');
    if (!backupStr) return;

    setProcessing(true);
    setToast(null);

    try {
      const backup = JSON.parse(backupStr);

      await db.transaction('rw', [db.chapters, db.novels], async () => {
        // Delete any new chapters that were not in the backup (garbage collect split chapters)
        const allChaptersInDb = await db.chapters.where('novelId').equals(backup.novelId).toArray();
        for (const ch of allChaptersInDb) {
          if (backup.tocMap[ch.id] === undefined) {
            await db.chapters.delete(ch.id);
          }
        }

        for (const ch of backup.affectedChapters) {
          await db.chapters.put(ch);
        }

        const allChapters = await db.chapters.where('novelId').equals(backup.novelId).toArray();
        for (const ch of allChapters) {
          const origIdx = backup.tocMap[ch.id];
          if (origIdx !== undefined && ch.chapterIndex !== origIdx) {
            await db.chapters.update(ch.id, { chapterIndex: origIdx });
          }
        }

        const restoredChapters = await db.chapters.where('novelId').equals(backup.novelId).toArray();
        await db.novels.update(backup.novelId, {
          wordCount: restoredChapters.reduce((sum, c) => sum + c.wordCount, 0),
        });
      });

      localStorage.removeItem('bmad_stitch_backup');
      setCanUndo(false);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : '回滚操作失败');
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300));
      setProcessing(false);
    }
  };

  const handleBulkStitch = async () => {
    if (processing || !selectedNovelId || selectedChapterIds.size < 2) return;

    const sortedSelected = chapters
      .filter((c) => selectedChapterIds.has(c.id) && c.id !== chapters[0]?.id)
      .map((c) => c.id);

    if (sortedSelected.length === 0) return;

    setProcessing(true);

    try {
      const backupChaptersSet = new Set<string>();
      let lastKeep: Chapter | null = null;

      for (const ch of chapters) {
        const isSelected = selectedChapterIds.has(ch.id) && ch.id !== chapters[0]?.id;
        if (!isSelected) {
          lastKeep = ch;
        } else if (lastKeep) {
          backupChaptersSet.add(lastKeep.id);
          backupChaptersSet.add(ch.id);
        }
      }

      const affectedChapters = chapters.filter((c) => backupChaptersSet.has(c.id));

      setCanUndo(backupStitchData(selectedNovelId, affectedChapters));

      await new Promise((resolve) => setTimeout(resolve, 200));

      const mergedMap = new Map<string, { content: string; sha: string }>();
      let lastKeepMem: Chapter | null = null;

      for (const ch of chapters) {
        const isSelected = selectedChapterIds.has(ch.id) && ch.id !== chapters[0]?.id;
        if (!isSelected) {
          lastKeepMem = ch;
        } else if (lastKeepMem) {
          const currentData: { content: string; sha: string } = mergedMap.get(lastKeepMem.id) || { content: lastKeepMem.content, sha: '' };
          const newContent: string = currentData.content + '\n\n' + ch.content;
          mergedMap.set(lastKeepMem.id, { content: newContent, sha: '' });
          lastKeepMem = Object.assign({}, lastKeepMem, { content: newContent }) as Chapter;
        }
      }

      const mergedKeys = Array.from(mergedMap.keys());
      for (const key of mergedKeys) {
        const value = mergedMap.get(key);
        if (value) {
          value.sha = await computeSha256(value.content);
        }
      }

      await db.transaction('rw', [db.chapters, db.novels], async () => {
        let lastKeepDb: Chapter | null = null;

        for (const ch of chapters) {
          const isSelected = selectedChapterIds.has(ch.id) && ch.id !== chapters[0]?.id;
          if (!isSelected) {
            lastKeepDb = await db.chapters.get(ch.id) || null;
          } else if (lastKeepDb) {
            const dbCurr = await db.chapters.get(ch.id);
            if (dbCurr) {
              const mergedData = mergedMap.get(lastKeepDb.id);
              if (mergedData) {
                await db.chapters.update(lastKeepDb.id, {
                  content: mergedData.content,
                  wordCount: mergedData.content.length,
                  contentSha256: mergedData.sha,
                  mapStatus: 'pending'
                });
                lastKeepDb.content = mergedData.content;
                lastKeepDb.wordCount = mergedData.content.length;
              }

              await db.chapters.delete(ch.id);
            }
          }
        }

        const remaining = await db.chapters
          .where('novelId')
          .equals(selectedNovelId)
          .sortBy('chapterIndex');

        for (let i = 0; i < remaining.length; i++) {
          await db.chapters.update(remaining[i].id, {
            chapterIndex: i + 1,
          });
        }

        const updatedChapters = await db.chapters.where('novelId').equals(selectedNovelId).toArray();
        await db.novels.update(selectedNovelId, {
          wordCount: updatedChapters.reduce((sum, c) => sum + c.wordCount, 0),
        });
      });

      setSelectedChapterIds(new Set());
      setActiveChapterId(null);

      setToast({
        show: true,
        message: `已批量缝合选中的 ${sortedSelected.length} 个章节`,
        countdown: 6000,
        type: 'stitch',
      });

    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : '批量合并操作失败');
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300));
      setProcessing(false);
    }
  };

  const handleSingleChapterExtract = async (chapterId: string) => {
    if (processing || !selectedNovelId) return;

    if (activeNovel?.analysisStatus === 'mapping' || activeNovel?.analysisStatus === 'reducing') {
      setToast({
        show: true,
        message: '已有一个全局分析任务在后台运行中，请等待其完成后再进行单章精测。',
        countdown: 6000,
      });
      return;
    }

    if (!crystalReady || getLlmConfigError(llmConfig)) {
      setIsCrystalOpen(true);
      return;
    }

    const chapter = chapters.find((c) => c.id === chapterId);
    if (!chapter) return;

    if (chapter.wordCount > 30000) {
      setToast({
        show: true,
        message: '本章字数已超过 30,000 字上限，为了保护大模型上下文及本地 IndexedDB 性能，请先用剪刀裁剪成小章。',
        countdown: 6000,
      });
      return;
    }

    setProcessing(true);
    setLocalExtractingMap((prev) => ({ ...prev, [chapterId]: true }));
    setErrorMsg(null);

    const controller = new AbortController();

    try {
      await runDnaExtraction(selectedNovelId, {
        targetChapterId: chapterId,
        signal: controller.signal,
      });

      setToast({
        show: true,
        message: '本章基因精测成功，小说全书 DNA 已增量固化重组。',
        countdown: 6000,
        type: 'success',
      });
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        await db.chapters.update(chapterId, {
          mapStatus: 'pending',
          errorMsg: undefined,
        });
      } else {
        await db.chapters.update(chapterId, {
          mapStatus: 'error',
          errorMsg: err instanceof Error ? err.message : String(err),
        });
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLocalExtractingMap((prev) => ({ ...prev, [chapterId]: false }));
      setProcessing(false);
    }
  };

  useEffect(() => {
    if (!toast || !toast.show) return;
    const timer = setInterval(() => {
      setToast((prev) => {
        if (!prev) return null;
        if (prev.countdown <= 100) {
          clearInterval(timer);
          // 仅 stitch 操作的撤销备份随其 toast 过期清理；success/警告类 toast 不再误删 stitch 备份。
          if (prev.type === 'stitch') {
            localStorage.removeItem('bmad_stitch_backup');
          }
          return null;
        }
        return { ...prev, countdown: prev.countdown - 100 };
      });
    }, 100);
    return () => clearInterval(timer);
  }, [toast]);

  // toast 消失（过期/被替换）时收起撤销可用态。
  useEffect(() => {
    if (!toast) setCanUndo(false);
  }, [toast]);

  const stageLabelMap: Record<UploadStage, string> = {
    idle: '',
    detecting: '自适应编码识别中...',
    reading: '流式数据分块清洗中...',
    splitting: '4轨正则判定与分章中...',
    hashing: '异步计算安全基因 SHA256 哈希中...',
    saving: '本地存储持久化事务处理中...',
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

    const resetWatchdog = () => {
      if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
      activeWatchdogRef.current = setTimeout(() => {
        if (activeWorkerRef.current) {
          activeWorkerRef.current.terminate();
          activeWorkerRef.current = null;
        }
        setUploading(false);
        setUploadStage('idle');
        setErrorMsg('此文档编码极度神秘，请确保它是未加密的标准 TXT 格式');
      }, 15000); // 15 seconds timeout watchdog for robustness (triage decision)
    };

    try {
      await ensureStorageCapacity(file);

      // Silently request storage persistence as per T3
      if (navigator.storage && navigator.storage.persist) {
        await navigator.storage.persist();
      }

      activeWorkerRef.current = new Worker('/workers/novel-parser-worker.js');
      resetWatchdog();

      activeWorkerRef.current.onmessage = async (e) => {
        const { type, stage, percent, data, message } = e.data;

        if (type === 'progress') {
          resetWatchdog(); // Reset watchdog on heartbeat message
          setUploadStage(stage);
          setUploadStageText(percent !== undefined ? `${percent}%` : '');
        } else if (type === 'success') {
          if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);

          setUploadStage('saving');
          setUploadStageText('');

          const { chapters: parsedChapters, splitMeta: computedSplitMeta, cleanedText, purifiedCount } = data;

          try {
            await db.transaction('rw', [db.novels, db.chapters], async () => {
              // Write to novels with camelCase fields
              await db.novels.add({
                id: novelId,
                name: novelName,
                wordCount: parsedChapters.reduce((sum: number, c: { wordCount: number }) => sum + c.wordCount, 0),
                createdAt: Date.now(),
                purifiedCount,
                sourceTextCleaned: cleanedText,
                splitStatus: computedSplitMeta.confidenceLevel === 'low' ? 'needs_review' : 'ok',
                splitMeta: computedSplitMeta,
                analysisStatus: 'idle',
                mapProgress: { total: 0, current: 0 },
                dnaCard: null,
              });

              // Format chapters with camelCase fields and contentSha256
              const chaptersToSave = parsedChapters.map((chapter: { chapterIndex: number; title: string; content: string; wordCount: number; contentSha256?: string }) => ({
                id: crypto.randomUUID(),
                novelId,
                chapterIndex: chapter.chapterIndex,
                name: chapter.title,
                content: chapter.content,
                wordCount: chapter.wordCount,
                contentSha256: chapter.contentSha256,
                status: 'unparsed',
                mapStatus: 'pending' as const,
              }));

              await db.chapters.bulkAdd(chaptersToSave);
            });

            setSelectedNovelId(novelId);
            resetChapterListView();
            // 切分置信度低 → 直接落到「校验切分」管理视图修复，而非把坏切分引向 DNA 提取。
            if (computedSplitMeta.confidenceLevel === 'low') {
              setManageMode(true);
            }
          } catch (err: unknown) {
            setErrorMsg(err instanceof Error ? err.message : '保存至本地数据库失败');
          } finally {
            if (activeWorkerRef.current) {
              activeWorkerRef.current.terminate();
              activeWorkerRef.current = null;
            }
            setUploading(false);
            setUploadStage('idle');
          }
        } else if (type === 'error') {
          if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
          setErrorMsg(message || '解析小说失败');
          if (activeWorkerRef.current) {
            activeWorkerRef.current.terminate();
            activeWorkerRef.current = null;
          }
          setUploading(false);
          setUploadStage('idle');
        }
      };

      activeWorkerRef.current.onerror = () => {
        if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
        setErrorMsg('Web Worker 线程发生运行期异常');
        if (activeWorkerRef.current) {
          activeWorkerRef.current.terminate();
          activeWorkerRef.current = null;
        }
        setUploading(false);
        setUploadStage('idle');
      };

      // Launch worker calculation
      activeWorkerRef.current.postMessage({ file });

    } catch (err: unknown) {
      if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
      if (activeWorkerRef.current) {
        activeWorkerRef.current.terminate();
        activeWorkerRef.current = null;
      }
      setErrorMsg(err instanceof Error ? err.message : '初始化 Web Worker 失败');
      setUploading(false);
      setUploadStage('idle');
    }
  };

  const doResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;
    if (!activeNovel.sourceTextCleaned?.trim()) { setErrorMsg('本地缓纯文本内容缺失，无法重分章'); return; }

    if (strategy === 'custom') {
      if (!repairRegex.trim()) { setErrorMsg('请填写正则'); return; }
      const validationError = validateLineRegex(repairRegex);
      if (validationError) { setErrorMsg(validationError); return; }
    }

    setRepairing(true);
    setErrorMsg(null);
    setUploadStage('splitting');
    setUploadStageText('');

    const resetWatchdog = () => {
      if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
      activeWatchdogRef.current = setTimeout(() => {
        if (activeWorkerRef.current) {
          activeWorkerRef.current.terminate();
          activeWorkerRef.current = null;
        }
        setRepairing(false);
        setUploadStage('idle');
        setErrorMsg('重分章操作超时，请检查正则是否存在回溯风险');
      }, 15000); // 15 seconds timeout watchdog for robustness (triage decision)
    };

    try {
      activeWorkerRef.current = new Worker('/workers/novel-parser-worker.js');
      resetWatchdog();

      activeWorkerRef.current.onmessage = async (e) => {
        const { type, stage, percent, data, message } = e.data;

        if (type === 'progress') {
          resetWatchdog();
          setUploadStage(stage);
          setUploadStageText(percent !== undefined ? `${percent}%` : '');
        } else if (type === 'success') {
          if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
          setUploadStage('saving');
          setUploadStageText('');

          const { chapters: parsedChapters, splitMeta: computedSplitMeta } = data;

          try {
            await db.transaction('rw', [db.novels, db.chapters], async () => {
              // Empty existing chapters first to prevent residue as per AC5
              await db.chapters.where('novelId').equals(activeNovel.id).delete();

              // Bulk add newly computed chapters with contentSha256
              const chaptersToSave = parsedChapters.map((chapter: { chapterIndex: number; title: string; content: string; wordCount: number; contentSha256?: string }) => ({
                id: crypto.randomUUID(),
                novelId: activeNovel.id,
                chapterIndex: chapter.chapterIndex,
                name: chapter.title,
                content: chapter.content,
                wordCount: chapter.wordCount,
                contentSha256: chapter.contentSha256,
                status: 'unparsed',
                mapStatus: 'pending' as const,
              }));

              await db.chapters.bulkAdd(chaptersToSave);

              // Update novel metadata
              await db.novels.update(activeNovel.id, {
                wordCount: parsedChapters.reduce((sum: number, c: { wordCount: number }) => sum + c.wordCount, 0),
                splitStatus: computedSplitMeta.confidenceLevel === 'low' ? 'needs_review' : 'ok',
                splitMeta: computedSplitMeta,
                analysisStatus: 'idle',
                mapProgress: { total: 0, current: 0 },
                dnaCard: null,
              });
            });

            resetChapterListView();
            setSelectedChapterIds(new Set());
            if (computedSplitMeta.confidenceLevel === 'low') {
              setToast({
                show: true,
                message: '重切后置信度仍偏低，可改用「分章规则」自定义正则，或用 ✨ 智能语义拆分。',
                countdown: 6000,
              });
            }
          } catch (err: unknown) {
            setErrorMsg(err instanceof Error ? err.message : '更新本地章节失败');
          } finally {
            if (activeWorkerRef.current) {
              activeWorkerRef.current.terminate();
              activeWorkerRef.current = null;
            }
            setRepairing(false);
            setUploadStage('idle');
          }
        } else if (type === 'error') {
          if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
          setErrorMsg(message || '重分章引擎解析失败');
          if (activeWorkerRef.current) {
            activeWorkerRef.current.terminate();
            activeWorkerRef.current = null;
          }
          setRepairing(false);
          setUploadStage('idle');
        }
      };

      activeWorkerRef.current.onerror = () => {
        if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
        setErrorMsg('Web Worker 重分章执行期异常');
        if (activeWorkerRef.current) {
          activeWorkerRef.current.terminate();
          activeWorkerRef.current = null;
        }
        setRepairing(false);
        setUploadStage('idle');
      };

      activeWorkerRef.current.postMessage({
        cleanedText: activeNovel.sourceTextCleaned,
        strategyId: strategy,
        customRegex: strategy === 'custom' ? repairRegex : undefined
      });

    } catch (err: unknown) {
      if (activeWatchdogRef.current) clearTimeout(activeWatchdogRef.current);
      if (activeWorkerRef.current) {
        activeWorkerRef.current.terminate();
        activeWorkerRef.current = null;
      }
      setErrorMsg(err instanceof Error ? err.message : '启动重分章 Worker 失败');
      setRepairing(false);
      setUploadStage('idle');
    }
  };

  const runResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing || uploading) return;
    if (activeNovel.analysisStatus === 'mapping' || activeNovel.analysisStatus === 'reducing') {
      setErrorMsg('正在提取 DNA，重新切分会删除正在写入的章节。请先到「DNA 提取」页暂停后再重切。');
      return;
    }
    if (!window.confirm('将覆盖所有章节数据并清空 DNA 进度')) return;
    await doResplit(strategy);
  };

  const filteredChapters = chapters.filter((chapter) => chapter.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const { paragraphs, originalLineIndices } = useMemo(() => {
    if (!activeChapter) return { paragraphs: [], originalLineIndices: [] };
    const lines = activeChapter.content.split('\n');
    const paragraphs: string[] = [];
    const originalLineIndices: number[] = [];
    lines.forEach((line, index) => {
      if (line.trim().length > 0) {
        paragraphs.push(line);
        originalLineIndices.push(index);
      }
    });
    return { paragraphs, originalLineIndices };
  }, [activeChapter]);

  const { predictedWordsA, predictedWordsB, percentageA, percentageB } = useMemo(() => {
    const activeGap = hoveredGapIndex !== null ? hoveredGapIndex : selectedMobileGapIndex;
    if (!activeChapter || activeGap === null || originalLineIndices.length === 0) {
      return { predictedWordsA: 0, predictedWordsB: 0, percentageA: 0, percentageB: 0 };
    }
    const lines = activeChapter.content.split('\n');
    const origLineIdx = originalLineIndices[activeGap];
    const lengthA = lines.slice(0, origLineIdx + 1).join('\n').length;
    const lengthB = lines.slice(origLineIdx + 1).join('\n').length;
    const total = lengthA + lengthB;
    const pctA = total > 0 ? Math.round((lengthA / total) * 100) : 0;
    const pctB = total > 0 ? Math.round((lengthB / total) * 100) : 0;
    return {
      predictedWordsA: lengthA,
      predictedWordsB: lengthB,
      percentageA: pctA,
      percentageB: pctB
    };
  }, [activeChapter, hoveredGapIndex, selectedMobileGapIndex, originalLineIndices]);

  const handleSplitAtParagraph = async (pIdx: number) => {
    if (processing || !selectedNovelId || !activeChapter) return;

    setProcessing(true);
    setSplittingIndex(pIdx);
    setIsTearing(true);

    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tearDuration = prefersReducedMotion ? 100 : 300;

    try {
      setCanUndo(backupStitchData(selectedNovelId, [activeChapter]));

      await new Promise((resolve) => setTimeout(resolve, tearDuration));

      const lines = activeChapter.content.split('\n');
      const origLineIdx = originalLineIndices[pIdx];
      const contentA = lines.slice(0, origLineIdx + 1).join('\n').trim();
      const contentB = lines.slice(origLineIdx + 1).join('\n').trim();

      const shaA = await computeSha256(contentA);
      const shaB = await computeSha256(contentB);

      const newChapterId = crypto.randomUUID();
      const currentChapterIndex = activeChapter.chapterIndex;

      await db.transaction('rw', [db.chapters, db.novels], async () => {
        await db.chapters.update(activeChapter.id, {
          content: contentA,
          wordCount: contentA.length,
          contentSha256: shaA,
          status: 'unparsed',
          mapStatus: 'pending'
        });

        const subsequent = await db.chapters
          .where('novelId')
          .equals(selectedNovelId)
          .filter((c) => c.chapterIndex > currentChapterIndex)
          .toArray();

        for (const sub of subsequent) {
          await db.chapters.update(sub.id, {
            chapterIndex: sub.chapterIndex + 1
          });
        }

        const newChapter: Chapter = {
          id: newChapterId,
          novelId: selectedNovelId,
          chapterIndex: currentChapterIndex + 1,
          name: `${activeChapter.name} (下)`,
          content: contentB,
          wordCount: contentB.length,
          contentSha256: shaB,
          status: 'unparsed',
          mapStatus: 'pending'
        };
        await db.chapters.add(newChapter);

        const updatedChapters = await db.chapters.where('novelId').equals(selectedNovelId).toArray();
        await db.novels.update(selectedNovelId, {
          wordCount: updatedChapters.reduce((sum, c) => sum + c.wordCount, 0),
        });
      });

      setToast({
        show: true,
        message: `已成功将章节【${activeChapter.name}】裁切为上下两章`,
        countdown: 6000,
      });

      setIsSplitMode(false);
      setSplitRecommendations([]); // 物理形状已变，旧推荐索引失效；如需可对新首章重新推荐
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : '裁切操作失败');
    } finally {
      setIsTearing(false);
      setSplittingIndex(null);
      setProcessing(false);
    }
  };

  // T6 / AC5: 调用后端语义推荐，获取“预涂色”裁切点；段落下标与右侧阅读器严格对齐。
  const runSmartSplit = async () => {
    if (smartSplitLoading || !activeNovel) return;
    // 优先针对超大章（>30000字）做语义拆分；否则回退到首章（分章失败的巨型单章场景）。
    const target = oversizedChapter || chapters[0];
    if (!target) return;

    // 取前 ~2 万字的非空自然段（与阅读器 paragraphs 同一推导，保证 splitParagraphIndex 对齐）
    const lines = target.content.split('\n');
    const paras: string[] = [];
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      if (paras.length > 0 && total + line.length > SMART_SPLIT_MAX_CHARS) break;
      paras.push(line);
      total += line.length;
    }
    if (paras.length < 2) {
      setErrorMsg('正文段落过少，暂无需要智能拆分。');
      return;
    }

    setActiveChapterId(target.id);
    setIsCrystalOpen(false);
    setSmartSplitLoading(true);
    setErrorMsg(null);
    try {
      const res = await postWithLlmConfig('/api/py/split-recommend', {
        paragraphs: paras,
        novelName: activeNovel.name,
      });
      if (!res.ok) {
        throw new Error(await readApiErrorMessage(res, '智能语义拆分失败'));
      }
      const data = (await res.json()) as { recommendations?: SplitRecommendation[] };
      const recs = (data.recommendations || [])
        .filter(
          (r) =>
            Number.isInteger(r.splitParagraphIndex) &&
            r.splitParagraphIndex >= 0 &&
            r.splitParagraphIndex < paras.length - 1
        )
        .sort((a, b) => a.splitParagraphIndex - b.splitParagraphIndex);
      setSplitRecommendations(recs);
      if (recs.length === 0) {
        setToast({ show: true, message: 'AI 未发现明显的语义切分点，可手动裁切。', countdown: 6000 });
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : '智能语义拆分失败');
    } finally {
      setSmartSplitLoading(false);
    }
  };

  // AC1: 未配置当前 Provider 的钥匙（或 Ollama 未就绪）则滑入水晶卡，否则直接拆分。
  const handleSmartSplitClick = () => {
    if (!crystalReady || getLlmConfigError(llmConfig)) {
      setIsCrystalOpen(true);
      return;
    }
    void runSmartSplit();
  };

  // AC1 / AC3: High-end Linear dark aesthetic drop舱
  if (!selectedNovelId) {
    return (
      <div
        className="mx-auto max-w-xl w-full p-8 rounded-2xl bg-[#0c0e20] border border-[#1b1e36] shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
      >
        <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".txt" className="hidden" />

        <div className="text-center py-4">
          <h1 className="text-xl font-medium tracking-tight bg-gradient-to-r from-white via-[#e2e8f0] to-[#94a3b8] bg-clip-text text-transparent">导入小说作品</h1>
          <p className="mt-2 text-xs text-slate-400">将 TXT 格式的小说拖入高奢暗黑虚线拖拽舱</p>
        </div>

        <div
          onClick={() => fileInputRef.current?.click()}
          className={`relative group cursor-pointer overflow-hidden rounded-xl border border-dashed py-14 px-8 text-center transition-all duration-[150ms] ${
            dragActive
              ? 'border-[#06b6d4] bg-[#06b6d4]/5 shadow-[0_0_20px_rgba(6,182,212,0.15),0_0_40px_rgba(94,106,210,0.1)]'
              : 'border-[#1b1e36] bg-[#080916] hover:border-[#5e6ad2]/50 hover:shadow-[0_0_15px_rgba(94,106,210,0.05)]'
          }`}
        >
          {/* Subtle hover laser flow lines */}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#5e6ad2]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

          <div className="space-y-4">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#10122c] border border-[#1b1e36] text-2xl transition-transform duration-300 group-hover:scale-110">
              📥
            </div>
            <div>
              <p className="text-sm font-medium text-slate-200 group-hover:text-[#06b6d4] transition-colors duration-150">
                {dragActive ? '释放以启动舱门' : '点击选择或拖拽文件到这里'}
              </p>
              <p className="mt-1.5 text-xs text-slate-500">
                支持 UTF-8 / GB18030 / BIG5 自适应检测，文件限制在 50MB 以内
              </p>
            </div>
          </div>
        </div>

        {uploading && (
          <div className="mt-6 flex flex-col items-center justify-center p-8 space-y-5 rounded-xl border border-[#1b1e36] bg-[#080916]/90 backdrop-blur-sm shadow-inner">
            {/* AC3: DNA dual-helix hardware GPU will-change animation ring */}
            <div className="relative w-16 h-16 will-change-transform">
              <svg className="w-full h-full animate-[spin_3s_linear_infinite]" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" stroke="url(#cyan-grad)" strokeWidth="3" strokeDasharray="180 60" fill="none" className="opacity-90" />
                <circle cx="50" cy="50" r="30" stroke="url(#purple-grad)" strokeWidth="2.5" strokeDasharray="120 40" fill="none" className="opacity-80 origin-center animate-[spin_2s_linear_infinite_reverse]" />
                <circle cx="50" cy="50" r="6" fill="#06b6d4" className="animate-pulse" />
                <defs>
                  <linearGradient id="cyan-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#06b6d4" />
                    <stop offset="100%" stopColor="#5e6ad2" />
                  </linearGradient>
                  <linearGradient id="purple-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#5e6ad2" />
                    <stop offset="100%" stopColor="#ec4899" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-slate-300">{stageLabelMap[uploadStage]}</p>
              {uploadStageText && <p className="text-xs text-[#06b6d4] font-mono tracking-wider">{uploadStageText}</p>}
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="mt-6 p-4 rounded-lg bg-red-950/20 border border-red-500/20 text-center">
            <p className="text-xs text-red-400 font-medium leading-relaxed">⚠️ {errorMsg}</p>
          </div>
        )}
      </div>
    );
  }

  // Chapter Review View
  return (
    <div className="flex h-[calc(100vh-8rem)] w-full overflow-hidden bg-[#0c0e20] border border-[#1b1e36] rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.6)]">
      {/* Left panel: outline tree */}
      <div className="w-[350px] shrink-0 border-r border-[#1b1e36] flex flex-col h-full bg-[#080916]">
        {/* Left header: info and settings */}
        <div className="p-4 border-b border-[#1b1e36] space-y-3 shrink-0">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100 truncate flex-1" title={activeNovel?.name || ''}>
              {activeNovel?.name}
            </h2>
            <button
              onClick={() => setSelectedNovelId(null)}
              className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300 font-mono transition-colors border border-[#1b1e36] px-1.5 py-0.5 rounded"
            >
              关闭
            </button>
          </div>
          <div className="text-[11px] text-[#8a8f98] font-mono leading-relaxed">
            <div>{formatWordCount(activeNovel?.wordCount || 0)}字 · {chapters.length}章</div>
            <div>均字：{Math.round(derivedStats?.avgChapterChars ?? 0)}字/章</div>
            {!!activeNovel?.purifiedCount && activeNovel.purifiedCount > 0 && (
              <div className="text-[#10b981]/80">已净化 {activeNovel.purifiedCount.toLocaleString()} 字噪点</div>
            )}
          </div>

          {/* AC1: 分章置信度极低时滑入的智能语义拆分入口 */}
          {canSmartSplit && (
            <button
              onClick={handleSmartSplitClick}
              disabled={smartSplitLoading || processing}
              className="w-full text-center py-2 px-2 rounded-lg text-xs font-semibold bg-gradient-to-r from-[#06b6d4]/15 to-[#5e6ad2]/15 hover:from-[#06b6d4]/25 hover:to-[#5e6ad2]/25 text-[#67e8f9] border border-[#06b6d4]/30 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5 animate-[fadeIn_200ms_ease-out] shadow-[0_0_15px_rgba(6,182,212,0.08)]"
              title="分章置信度极低，借助大模型智能推荐切开点"
            >
              {smartSplitLoading ? '✨ 正在智能分析…' : '✨ 智能语义拆分'}
            </button>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {needsSmartRepair ? (
              <button
                onClick={() => void runResplit('auto_v2')}
                disabled={repairing}
                className="flex-1 text-center py-1.5 px-2 rounded text-xs font-medium bg-[#06b6d4]/10 hover:bg-[#06b6d4]/20 text-[#06b6d4] border border-[#06b6d4]/20 transition-all disabled:opacity-50"
              >
                {repairing ? '修复中...' : '⚠️ 智能修复'}
              </button>
            ) : (
              <button
                onClick={() => setManageMode(false)}
                className="flex-1 text-center py-1.5 px-2 rounded text-xs font-medium bg-[#5e6ad2]/10 hover:bg-[#5e6ad2]/20 text-[#828fff] border border-[#5e6ad2]/20 transition-all"
              >
                前往 DNA 提炼 →
              </button>
            )}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`px-2 py-1.5 rounded text-xs font-medium border transition-all ${
                showAdvanced
                  ? 'bg-[#1b1e36] border-[#34343a] text-slate-200'
                  : 'bg-transparent border-[#1b1e36] text-slate-400 hover:text-slate-200'
              }`}
            >
              分章规则
            </button>
          </div>

          {/* Foldable Resplit settings */}
          {showAdvanced && (
            <div className="pt-2 border-t border-[#1b1e36]/50 space-y-3 animate-[fadeIn_150ms_ease-out]">
              <div className="flex items-center gap-2">
                <select
                  value={repairStrategy}
                  onChange={(e) => setRepairStrategy(e.target.value as SplitStrategyId)}
                  className="flex-1 border border-[#1b1e36] rounded bg-[#0c0e20] text-slate-300 px-2 py-1 text-xs focus:outline-none focus:border-[#5e6ad2]"
                >
                  <option value="auto_v2">智能自动采信</option>
                  <option value="zh_strict">中文严格</option>
                  <option value="zh_extended">中文扩展</option>
                  <option value="mixed">混合</option>
                  <option value="en_basic">英文</option>
                  <option value="custom">自定义</option>
                </select>
                <button
                  onClick={() => void runResplit(repairStrategy)}
                  disabled={repairing || uploading}
                  className="text-xs bg-[#5e6ad2]/20 hover:bg-[#5e6ad2]/30 text-[#e2e8f0] px-3 py-1.5 rounded border border-[#5e6ad2]/30 hover:border-[#5e6ad2]/50 disabled:opacity-30 transition-all font-medium"
                >
                  执行
                </button>
              </div>
              {repairStrategy === 'custom' && (
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-500 font-mono">正则表达式</label>
                  <input
                    type="text"
                    value={repairRegex}
                    onChange={(e) => setRepairRegex(e.target.value)}
                    className="w-full border border-[#1b1e36] bg-[#0c0e20] text-slate-300 p-1.5 rounded text-xs font-mono focus:outline-none focus:border-[#5e6ad2]"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Diagnostic info or progress bar */}
        {(uploading || repairing || errorMsg || needsSmartRepair) && (
          <div className="p-3 bg-[#0c0e20]/60 border-b border-[#1b1e36]/60 text-xs space-y-1 shrink-0">
            {needsSmartRepair && (
              <div className="flex items-center gap-1.5 text-amber-500 font-mono">
                <span>● 需要校验</span>
                {splitMeta && <span className="text-[#8a8f98]">({Math.round(splitMeta.confidence * 100)}% 置信度)</span>}
              </div>
            )}
            {reviewReasons.length > 0 && (
              <div className="text-[10px] text-slate-500 font-mono truncate">
                原因: {reviewReasons.join(' · ')}
              </div>
            )}
            {(uploading || repairing) && (
              <div className="flex items-center gap-2 text-[#06b6d4]">
                <div className="relative w-3.5 h-3.5">
                  <svg className="w-full h-full animate-spin" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="12" strokeDasharray="160 80" fill="none" />
                  </svg>
                </div>
                <span className="font-mono">{stageLabelMap[uploadStage]} {uploadStageText}</span>
              </div>
            )}
            {errorMsg && (
              <div className="text-red-400 font-mono leading-relaxed truncate" title={errorMsg}>
                ⚠️ {errorMsg}
              </div>
            )}
          </div>
        )}

        {/* Chapter Search Filter */}
        <div className="p-3 border-b border-[#1b1e36]/40 shrink-0">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="过滤章节标题..."
            className="w-full border border-[#1b1e36] bg-[#0c0e20] text-slate-300 px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-[#06b6d4] transition-colors"
          />
        </div>

        {/* Outline Tree nodes */}
        <div 
          className={`flex-1 overflow-y-auto p-2 space-y-1 ${processing ? 'pointer-events-none opacity-60' : ''}`} 
          role="tree" 
          aria-label="章节大纲树"
        >
          {filteredChapters.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-500 font-mono">未找到匹配的章节</p>
          ) : (
            filteredChapters.map((chapter) => {
              const isSelected = activeChapterId === chapter.id;
              const wordCount = chapter.wordCount;
              
              let warningType: 'short' | 'long' | 'normal' = 'normal';
              if (wordCount < 120) warningType = 'short';
              else if (wordCount > 12000) warningType = 'long';
              
              let textClass = 'text-slate-400 hover:text-slate-200';
              let bgClass = 'hover:bg-[#10122c]/30';
              let borderClass = 'border-l-2 border-transparent';
              
              if (isSelected) {
                bgClass = 'bg-[#10122c]';
                borderClass = 'border-l-2 border-[#06b6d4]';
                if (warningType === 'short') {
                  textClass = 'text-[#f59e0b] font-medium';
                } else if (warningType === 'long') {
                  textClass = 'text-[#3b82f6] font-medium';
                } else {
                  textClass = 'text-white font-medium';
                }
              } else {
                if (warningType === 'short') {
                  textClass = 'text-[#f59e0b]/80 hover:text-[#f59e0b]';
                } else if (warningType === 'long') {
                  textClass = 'text-[#3b82f6]/80 hover:text-[#3b82f6]';
                }
              }
              
              return (
                <div
                  key={chapter.id}
                  role="treeitem"
                  aria-selected={isSelected}
                  aria-label={`第${chapter.chapterIndex}章：${chapter.name}，字数${chapter.wordCount}字`}
                  tabIndex={0}
                  onClick={() => {
                    if (processing) return;
                    setActiveChapterId(chapter.id);
                  }}
                  onKeyDown={(e) => {
                    if (processing) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveChapterId(chapter.id);
                    }
                  }}
                  className={`flex items-center justify-between px-3 py-2 text-xs rounded transition-all duration-150 cursor-pointer group ${bgClass} ${borderClass} focus:outline-none focus:ring-1 focus:ring-[#06b6d4]/40`}
                >
                  <div className="flex items-center min-w-0 gap-2 flex-1">
                    <input
                      type="checkbox"
                      checked={selectedChapterIds.has(chapter.id)}
                      disabled={processing}
                      onChange={(e) => {
                        e.stopPropagation();
                        if (processing) return;
                        setSelectedChapterIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(chapter.id)) {
                            next.delete(chapter.id);
                          } else {
                            next.add(chapter.id);
                          }
                          return next;
                        });
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="mr-2 h-3.5 w-3.5 rounded border-[#1b1e36] bg-[#0c0e20] text-[#06b6d4] focus:ring-[#06b6d4]/40 shrink-0 cursor-pointer disabled:cursor-not-allowed"
                      aria-label={`选择第${chapter.chapterIndex}章`}
                    />
                    <span className="text-[#8a8f98] font-mono shrink-0 w-8">{chapter.chapterIndex}</span>
                    <span className={`truncate ${textClass}`}>{chapter.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 pl-2">
                    {/* DNA Sequencing State Badge or Hover Action */}
                    { (chapter.mapStatus === 'mapping' || localExtractingMap[chapter.id]) ? (
                      <div className="flex items-center gap-1 text-cyan-400 font-mono text-[10px]">
                        <svg className="w-3 h-3 animate-spin text-cyan-400" viewBox="0 0 100 100">
                          <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="12" strokeDasharray="160 80" fill="none" />
                        </svg>
                        <span>[🧬 测序中...]</span>
                      </div>
                    ) : chapter.mapStatus === 'done' ? (
                      <div className="flex items-center gap-1.5">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" title="已完成 DNA 提炼">
                          🧬
                        </span>
                        <button
                          disabled={processing}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSingleChapterExtract(chapter.id);
                          }}
                          className="hidden group-hover:flex items-center gap-0.5 rounded bg-[#06b6d4]/10 hover:bg-[#06b6d4]/20 border border-[#06b6d4]/30 px-1 py-0.5 text-[9px] text-[#67e8f9] transition-all"
                          title="重新精测本章"
                        >
                          🧬 精测
                        </button>
                      </div>
                    ) : chapter.mapStatus === 'error' ? (
                      <div className="flex items-center gap-1.5">
                        <div className="relative group/error shrink-0">
                          <span className="text-red-500 cursor-help" title={chapter.errorMsg || '解析失败'}>⚠️</span>
                          {chapter.errorMsg && (
                            <div className="absolute bottom-full right-0 mb-1 hidden group-hover/error:block w-48 p-2 rounded-lg bg-[#0c0e20]/90 border border-red-500/30 backdrop-blur-md shadow-xl text-[10px] text-red-200 z-50 whitespace-normal break-all">
                              {chapter.errorMsg}
                            </div>
                          )}
                        </div>
                        <button
                          disabled={processing}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSingleChapterExtract(chapter.id);
                          }}
                          className="hidden group-hover:flex items-center gap-0.5 rounded bg-[#06b6d4]/10 hover:bg-[#06b6d4]/20 border border-[#06b6d4]/30 px-1 py-0.5 text-[9px] text-[#67e8f9] transition-all"
                          title="重试精测本章"
                        >
                          🧬 精测
                        </button>
                      </div>
                    ) : (
                      <button
                        disabled={processing}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSingleChapterExtract(chapter.id);
                        }}
                        className="hidden group-hover:flex items-center gap-1 rounded bg-[#06b6d4]/10 hover:bg-[#06b6d4]/20 border border-[#06b6d4]/30 px-1.5 py-0.5 text-[10px] text-[#67e8f9] transition-all"
                        title="对本章单独执行 [🧬 精测]"
                      >
                        🧬 精测
                      </button>
                    )}

                    {warningType === 'short' && (
                      <button
                        disabled={chapter.id === chapters[0]?.id || processing}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStitch(chapter.id);
                        }}
                        className={`opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-[#f59e0b] hover:text-white bg-[#f59e0b]/10 hover:bg-[#f59e0b]/30 px-1.5 py-0.5 rounded border border-[#f59e0b]/20 disabled:opacity-40 disabled:cursor-not-allowed`}
                        title={chapter.id === chapters[0]?.id ? '第一章无法向前缝合' : '将本章物理缝合至上一章'}
                        aria-label="一键缝合"
                      >
                        🔗 缝合
                      </button>
                    )}
                    <span className={`font-mono text-[10px] ${isSelected ? 'opacity-90' : 'opacity-60'}`}>
                      {wordCount}
                    </span>
                    {warningType === 'short' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] shrink-0" title="字数极少警告" />
                    )}
                    {warningType === 'long' && (
                      <button
                        disabled={processing}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveChapterId(chapter.id);
                          setIsSplitMode(true);
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-[#3b82f6] hover:text-white bg-[#3b82f6]/10 hover:bg-[#3b82f6]/30 px-1.5 py-0.5 rounded border border-[#3b82f6]/20 disabled:opacity-40"
                        title="帮我裁切本章"
                        aria-label="一键裁切"
                      >
                        ✂️ 裁切
                      </button>
                    )}
                    {warningType === 'long' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] shrink-0" title="字数极长警告" />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right panel: golden reader / empty state */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#05060f] relative">
        {!activeChapter ? (
          /* Empty state with rotating orbit */
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-6 select-none">
            <div className="relative w-32 h-32 will-change-transform animate-[spin_60s_linear_infinite]">
              <svg className="w-full h-full opacity-30" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" stroke="#06b6d4" strokeWidth="0.5" strokeDasharray="4 6" fill="none" />
                <circle cx="50" cy="50" r="28" stroke="#5e6ad2" strokeWidth="0.5" strokeDasharray="3 4" fill="none" />
                <circle cx="50" cy="50" r="16" stroke="#8a8f98" strokeWidth="0.5" fill="none" />
                
                <circle cx="50" cy="10" r="2" fill="#06b6d4" className="animate-pulse" />
                <circle cx="22" cy="50" r="1.5" fill="#5e6ad2" />
                <circle cx="50" cy="66" r="1" fill="#8a8f98" />
              </svg>
              <div className="absolute inset-0 m-auto w-3 h-3 bg-[#06b6d4] rounded-full blur-[4px] opacity-80" />
            </div>
            
            <div className="max-w-xs space-y-2">
              <p className="text-sm font-medium text-slate-300 font-sans">智能章节校验预检舱</p>
              <p className="text-xs text-slate-500 leading-relaxed font-sans">
                请在左侧目录树中选择章节，系统将自动对章节进行智能字数诊断与结构分析。
              </p>
            </div>
          </div>
        ) : isSplitMode || splitRecommendations.length > 0 ? (
          /* Double-Column Split Dashboard (manual scissors OR AI 智能语义拆分建议) */
          <div key={`split-${activeChapter.id}`} className="flex-1 flex flex-col h-full overflow-hidden animate-[fadeIn_150ms_ease-out]">
            <style>{`
              @keyframes fadeIn {
                from { opacity: 0; transform: translateY(4px); }
                to { opacity: 1; transform: translateY(0); }
              }
              @keyframes tearUp {
                0% { transform: translateY(0); opacity: 1; }
                100% { transform: translateY(-4px); opacity: 0.5; }
              }
              @keyframes tearDown {
                0% { transform: translateY(0); opacity: 1; }
                100% { transform: translateY(4px); opacity: 0.5; }
              }
              @keyframes glowFade {
                0% { height: 1px; opacity: 1; box-shadow: 0 0 8px #06b6d4; }
                100% { height: 8px; opacity: 0; box-shadow: 0 0 16px #06b6d4; }
              }
              .animate-tear-up {
                animation: tearUp 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
              }
              .animate-tear-down {
                animation: tearDown 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
              }
              .animate-glow-fade {
                animation: glowFade 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
              }
              @media (prefers-reduced-motion: reduce) {
                @keyframes fadeTear {
                  0% { opacity: 1; }
                  100% { opacity: 0.8; }
                }
                .animate-tear-up, .animate-tear-down {
                  animation: fadeTear 100ms ease-out forwards;
                }
                .animate-glow-fade {
                  animation: none;
                  opacity: 0;
                }
              }
            `}</style>

            {/* Split Mode Header */}
            <div className="px-8 py-4 border-b border-[#1b1e36]/30 flex items-center justify-between shrink-0 bg-[#080916]/40 backdrop-blur-sm">
              <div className="min-w-0">
                <div className="text-[10px] font-mono tracking-widest text-[#06b6d4] uppercase">
                  {splitRecommendations.length > 0 ? '✨ AI 智能语义拆分建议' : '✂️ 游标剪刀交互裁切舱'}
                </div>
                <h3 className="text-sm font-semibold text-white truncate mt-0.5">
                  {splitRecommendations.length > 0
                    ? `已推荐 ${splitRecommendations.length} 处切开点：${activeChapter.name}`
                    : `正在裁切：${activeChapter.name}`}
                </h3>
              </div>
              <div className="flex items-center gap-3">
                {canSmartSplit && (
                  <button
                    onClick={handleSmartSplitClick}
                    disabled={smartSplitLoading || processing}
                    className="text-xs bg-[#06b6d4]/15 hover:bg-[#06b6d4]/25 text-[#67e8f9] px-3 py-1.5 rounded-lg border border-[#06b6d4]/30 transition-colors disabled:opacity-50"
                  >
                    {smartSplitLoading ? '分析中…' : splitRecommendations.length > 0 ? '↻ 重新推荐' : '✨ 智能语义拆分'}
                  </button>
                )}
                <button
                  onClick={() => {
                    setIsSplitMode(false);
                    setHoveredGapIndex(null);
                    setSelectedMobileGapIndex(null);
                    setSplitRecommendations([]);
                  }}
                  className="text-xs bg-[#1b1e36] hover:bg-[#1b1e36]/80 text-slate-300 hover:text-white px-3 py-1.5 rounded-lg border border-[#34343a] transition-colors"
                >
                  返回阅读模式
                </button>
              </div>
            </div>

            <div className="flex-1 flex h-full overflow-hidden relative">
              {/* Left Column: 裁剪仪表盘 (Split Control Dashboard) */}
              <div 
                className="w-[260px] shrink-0 border-r border-[#1b1e36] bg-[#080916]/80 backdrop-blur-sm p-5 flex flex-col justify-between h-full text-xs"
              >
                <div className="space-y-6">
                  <div>
                    <h4 className="text-[#8a8f98] uppercase tracking-wider text-[10px] font-mono mb-2">当前章节数据</h4>
                    <div className="space-y-1.5 font-mono text-slate-300">
                      <div>总字数：{activeChapter.wordCount} 字</div>
                      <div>段落数：{paragraphs.length} 段</div>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-[#8a8f98] uppercase tracking-wider text-[10px] font-mono mb-2">裁切字数预测</h4>
                    {(hoveredGapIndex !== null || selectedMobileGapIndex !== null) ? (
                      <div className="space-y-3 bg-[#0c0e20]/60 p-3 rounded-lg border border-[#1b1e36] animate-[fadeIn_150ms_ease-out]">
                        <div className="space-y-1">
                          <div className="text-slate-400">前半章 ({activeChapter.name}):</div>
                          <div className="font-mono text-[#06b6d4] font-semibold">{predictedWordsA} 字 ({percentageA}%)</div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-slate-400">后半章 ({activeChapter.name} (下)):</div>
                          <div className="font-mono text-[#3b82f6] font-semibold">{predictedWordsB} 字 ({percentageB}%)</div>
                        </div>
                        <div className="mt-2 pt-2 border-t border-[#1b1e36]/40 text-[10px]">
                          {(predictedWordsA < 2000 || predictedWordsB < 2000) ? (
                            <span className="text-amber-500">⚠️ 分割后章节偏短</span>
                          ) : (
                            <span className="text-[#10b981]">✅ 比例非常协调</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="text-slate-500 italic p-3 bg-[#0c0e20]/20 rounded-lg border border-[#1b1e36]/30">
                        请将鼠标悬浮在右侧段落之间的缝隙上以预览裁切比例
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-[#8a8f98] uppercase tracking-wider text-[10px] font-mono">操作指南</h4>
                    <ul className="list-disc pl-4 text-slate-400 space-y-1 leading-relaxed">
                      <li>鼠标悬浮于段落行间缝隙</li>
                      <li>点击出现的 <span className="text-[#06b6d4]">“在此剪开”</span> 气泡</li>
                      <li>♿ 移动端：双击缝隙，或点击段落左侧的行号 `¶` 即可触发</li>
                      <li>裁切后支持 6 秒撤销</li>
                    </ul>
                  </div>
                </div>

                <div className="pt-4 border-t border-[#1b1e36]/40">
                  <div className="text-[10px] text-slate-500 font-mono leading-relaxed">
                    ⚡ IndexedDB 本地原子事务保护
                  </div>
                </div>
              </div>

              {/* Right Column: Paragraphs List */}
              <div className="flex-1 overflow-y-auto px-8 py-6 relative">
                <div className="max-w-2xl mx-auto space-y-2 py-4">
                  {paragraphs.map((pText, pIdx) => {
                    const isTearingUp = isTearing && splittingIndex !== null && pIdx <= splittingIndex;
                    const isTearingDown = isTearing && splittingIndex !== null && pIdx > splittingIndex;
                    const isGlowFade = isTearing && splittingIndex === pIdx;
                    const rec = recByIndex[pIdx];

                    return (
                      <React.Fragment key={pIdx}>
                        {/* Paragraph node */}
                        <div 
                          className={`group/paragraph flex items-start gap-4 py-2 relative transition-all duration-300 ${
                            isTearingUp ? 'animate-tear-up' : ''
                          } ${
                            isTearingDown ? 'animate-tear-down' : ''
                          }`}
                        >
                          {/* Paragraph line number for accessibility */}
                          <button
                            onClick={() => {
                              if (processing) return;
                              setSelectedMobileGapIndex(pIdx);
                            }}
                            className="font-mono text-[10px] text-slate-600 hover:text-[#06b6d4] hover:bg-[#06b6d4]/10 rounded px-1.5 py-0.5 shrink-0 transition-all select-none opacity-50 group-hover/paragraph:opacity-100"
                            title="激活本段落后的剪开气泡"
                          >
                            ¶ {(pIdx + 1).toString().padStart(2, '0')}
                          </button>
                          <p className="font-sans text-sm leading-[1.8] text-slate-300 whitespace-pre-wrap tracking-wide flex-1 select-text">
                            {pText}
                          </p>
                        </div>

                        {/* Inter-paragraph gap hotzone */}
                        {pIdx < paragraphs.length - 1 && (
                          <div
                            onMouseEnter={() => {
                              if (processing) return;
                              setHoveredGapIndex(pIdx);
                            }}
                            onMouseLeave={() => {
                              if (processing) return;
                              setHoveredGapIndex(null);
                            }}
                            onDoubleClick={() => {
                              if (processing) return;
                              handleSplitAtParagraph(pIdx);
                            }}
                            className={`relative w-full flex items-center justify-center group/split-gap z-10 ${rec ? '' : 'h-6 cursor-pointer'}`}
                          >
                            {rec ? (
                              /* AC5: AI 推荐裁切点“预涂色”高亮 + 复用 Story 1.5 原子切分事务 */
                              <div className="w-full my-1.5 bg-[#06b6d4]/10 border border-[#06b6d4]/30 rounded-lg p-2 backdrop-blur-sm animate-[fadeIn_200ms_ease-out]">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[11px] font-medium text-[#67e8f9]">💡 AI 推荐在此拆分</div>
                                    <div className="mt-0.5 text-[11px] leading-relaxed text-slate-300">{rec.reason}</div>
                                    {rec.suggestedTitle && (
                                      <div className="mt-1 truncate font-mono text-[10px] text-slate-500">
                                        下半章建议标题：{rec.suggestedTitle}
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (processing) return;
                                      handleSplitAtParagraph(pIdx);
                                    }}
                                    disabled={processing}
                                    className="shrink-0 self-center flex items-center gap-1 rounded-full border border-[#06b6d4] bg-[#06b6d4]/20 px-3 py-1.5 text-[11px] font-semibold text-white shadow-[0_0_15px_rgba(6,182,212,0.25)] transition-all hover:bg-[#06b6d4]/35 disabled:opacity-40"
                                  >
                                    确认在此拆分 ✂️
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                {/* Fluorescent blue gradient dashed cut line */}
                                <div className={`w-full h-0.5 border-t border-dashed transition-all duration-150 ${
                                  isGlowFade
                                    ? 'animate-glow-fade border-[#06b6d4]'
                                    : 'border-[#06b6d4]/40 group-hover/split-gap:border-[#06b6d4] opacity-30 group-hover/split-gap:opacity-100 group-hover/split-gap:animate-pulse'
                                }`} />

                                {/* Glassmorphic split button */}
                                {(!isTearing && (hoveredGapIndex === pIdx || selectedMobileGapIndex === pIdx)) && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (processing) return;
                                      handleSplitAtParagraph(pIdx);
                                    }}
                                    disabled={processing}
                                    className="absolute transition-all duration-200 flex items-center gap-1 px-3 py-1 rounded-full bg-[#0c0e20]/90 border border-[#06b6d4] text-[10px] font-semibold text-white shadow-[0_0_15px_rgba(6,182,212,0.3)] backdrop-blur-md cursor-pointer pointer-events-auto z-20"
                                  >
                                    ✂️ 在此剪开
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Reader mode with distraction-free layout */
          <div key={activeChapter.id} className="flex-1 flex flex-col h-full overflow-hidden animate-[fadeIn_150ms_ease-out]">
            <style>{`
              @keyframes fadeIn {
                from { opacity: 0; transform: translateY(4px); }
                to { opacity: 1; transform: translateY(0); }
              }
            `}</style>
            
            {/* Reader header */}
            <div className="px-8 py-4 border-b border-[#1b1e36]/30 flex items-center justify-between shrink-0 bg-[#080916]/40 backdrop-blur-sm">
              <div className="min-w-0">
                <div className="text-[10px] font-mono tracking-widest text-[#8a8f98] uppercase">
                  Chapter {activeChapter.chapterIndex}
                </div>
                <h3 className="text-sm font-semibold text-white truncate mt-0.5">
                  {activeChapter.name}
                </h3>
              </div>
              <div className="flex items-center gap-4">
                {activeChapter.wordCount > 12000 && (
                  <button
                    onClick={() => setIsSplitMode(true)}
                    disabled={processing}
                    className="text-xs bg-[#3b82f6]/20 hover:bg-[#3b82f6]/35 text-[#3b82f6] hover:text-blue-300 font-semibold px-3 py-1.5 rounded-lg border border-[#3b82f6]/30 flex items-center gap-1 transition-all"
                  >
                    ✂️ 帮我裁切
                  </button>
                )}
                <div className="text-xs font-mono text-slate-400 shrink-0">
                  {activeChapter.wordCount} 字
                </div>
              </div>
            </div>
            
            {/* Scrollable text container with absolute notifications */}
            <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6 relative select-text">
              {/* Warnings panel */}
              {activeChapter.wordCount < 120 && (
                <div className="p-3.5 rounded-xl border border-[#f59e0b]/20 bg-[#f59e0b]/10 text-amber-200 backdrop-blur-md text-xs leading-relaxed flex items-start gap-2.5 shadow-lg shadow-black/40 animate-[fadeIn_150ms_ease-out]">
                  <span className="text-base shrink-0">⚠️</span>
                  <div>
                    <span className="font-semibold">本章字数极低（只有 {activeChapter.wordCount} 字）。</span>
                    似乎是请假条或闲聊，建议在后续微操中将其进行一键合并 🔗。
                  </div>
                </div>
              )}
              
              {activeChapter.wordCount > 12000 && (
                <div className="p-3.5 rounded-xl border border-[#3b82f6]/20 bg-[#3b82f6]/10 text-blue-200 backdrop-blur-md text-xs leading-relaxed flex items-start gap-2.5 shadow-lg shadow-black/40 animate-[fadeIn_150ms_ease-out]">
                  <span className="text-base shrink-0">✂️</span>
                  <div className="flex-1 flex justify-between items-center gap-4">
                    <div>
                      <span className="font-semibold">本章字数过长（含有 {activeChapter.wordCount} 字）。</span>
                      建议使用物理剪刀剪开以提高 AI 测序精度 ✂️。
                    </div>
                    <button
                      onClick={() => setIsSplitMode(true)}
                      disabled={processing}
                      className="text-xs bg-[#3b82f6] hover:bg-[#3b82f6]/85 text-white font-semibold px-3 py-1.5 rounded-lg transition-all"
                    >
                      ✂️ 帮我裁切
                    </button>
                  </div>
                </div>
              )}
              
              {/* Chapter Text body */}
              <article className="font-sans text-base leading-[1.8] text-slate-300 whitespace-pre-wrap tracking-wide max-w-2xl mx-auto py-4">
                {activeChapter.content}
              </article>
            </div>
          </div>
        )}

        {/* AC1: JIT 水晶能量配置卡 — 右侧滑入式（cubic-bezier 高奢曲线，400px，backdrop-blur） */}
        <div
          className={`absolute right-0 top-0 z-30 h-full w-[400px] transition-transform duration-[400ms] ${
            isCrystalOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
          }`}
          style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
          aria-hidden={!isCrystalOpen}
        >
          <div className="flex h-full flex-col border-l border-[#1b1e36] bg-[#0c0e20]/90 backdrop-blur-md shadow-[0_0_40px_rgba(0,0,0,0.55)]">
            {/* Totem header */}
            <div className="relative shrink-0 overflow-hidden border-b border-[#1b1e36] p-5">
              <svg className="pointer-events-none absolute -right-6 -top-6 h-40 w-40 opacity-20" viewBox="0 0 100 100" fill="none">
                <polygon points="50,8 86,30 86,70 50,92 14,70 14,30" stroke="#06b6d4" strokeWidth="0.6" />
                <polygon points="50,24 72,37 72,63 50,76 28,63 28,37" stroke="#5e6ad2" strokeWidth="0.5" />
                <line x1="50" y1="8" x2="50" y2="92" stroke="#06b6d4" strokeWidth="0.3" />
                <line x1="14" y1="30" x2="86" y2="70" stroke="#5e6ad2" strokeWidth="0.3" />
                <line x1="86" y1="30" x2="14" y2="70" stroke="#5e6ad2" strokeWidth="0.3" />
              </svg>
              <div className="relative flex items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-[#06b6d4]">Crystal Config</div>
                  <h3 className="mt-0.5 text-sm font-semibold text-white">水晶能量配置</h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">粘贴云端水晶金钥，或切换本地 Ollama 离线 AI。</p>
                </div>
                <button
                  onClick={() => setIsCrystalOpen(false)}
                  className="shrink-0 rounded border border-[#1b1e36] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300"
                >
                  关闭
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {/* Provider tabs */}
              <div className="flex flex-wrap gap-1.5">
                {listProviderMetas().map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setActiveProvider(p.id)}
                    className={`rounded-md border px-2.5 py-1 text-[11px] transition-all ${
                      activeProvider === p.id
                        ? 'border-[#06b6d4]/40 bg-[#06b6d4]/15 text-[#67e8f9]'
                        : 'border-[#1b1e36] bg-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>

              {activeProviderMeta.requiresApiKey ? (
                <div className="space-y-1.5">
                  <label className="text-[11px] text-slate-400">云端水晶金钥 (API Key)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type={showCrystalKey ? 'text' : 'password'}
                      value={activeProfile.apiKey}
                      onChange={(e) => updateActiveProviderProfile({ apiKey: e.target.value })}
                      onBlur={(e) => updateActiveProviderProfile({ apiKey: e.target.value.trim() })}
                      placeholder="sk-..."
                      className="flex-1 rounded border border-[#1b1e36] bg-[#080916] px-2.5 py-1.5 font-mono text-xs text-slate-200 focus:border-[#06b6d4] focus:outline-none"
                    />
                    <button
                      onClick={() => setShowCrystalKey((v) => !v)}
                      className="shrink-0 text-[11px] text-slate-500 hover:text-slate-300"
                    >
                      {showCrystalKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-600">🔒 密钥仅以混淆形式存储于本地浏览器，绝不上传服务器。</p>
                </div>
              ) : (
                /* AC3/AC4: 本地 Ollama 心跳在线状态点 + 模型审计引导 */
                <div className="space-y-2 rounded-lg border border-[#1b1e36] bg-[#080916]/60 p-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full transition-colors duration-100 ${
                        ollamaStatus === 'online'
                          ? 'bg-[#10b981]'
                          : ollamaStatus === 'checking' || ollamaStatus === 'unknown'
                          ? 'animate-pulse bg-slate-500'
                          : 'bg-[#f59e0b]'
                      }`}
                    />
                    <span className="text-xs font-medium text-slate-200">
                      {ollamaStatus === 'online'
                        ? '在线就绪 🟢'
                        : ollamaStatus === 'checking'
                        ? '星体心跳探测中…'
                        : ollamaStatus === 'unknown'
                        ? '待探测'
                        : '星体静思 ⚠️'}
                    </span>
                  </div>
                  {ollamaMessage && <p className="text-[11px] leading-relaxed text-slate-400">{ollamaMessage}</p>}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[11px] text-slate-400">Base URL</label>
                <input
                  type="text"
                  value={activeProfile.baseUrl}
                  onChange={(e) => updateActiveProviderProfile({ baseUrl: e.target.value })}
                  onBlur={(e) => updateActiveProviderProfile({ baseUrl: e.target.value.trim() })}
                  placeholder="https://api.example.com/v1"
                  className="w-full rounded border border-[#1b1e36] bg-[#080916] px-2.5 py-1.5 font-mono text-xs text-slate-200 focus:border-[#06b6d4] focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] text-slate-400">模型</label>
                <input
                  list="crystal-model-presets"
                  value={activeProfile.model}
                  onChange={(e) => updateActiveProviderProfile({ model: e.target.value })}
                  onBlur={(e) => updateActiveProviderProfile({ model: e.target.value.trim() })}
                  placeholder="gpt-4o"
                  className="w-full rounded border border-[#1b1e36] bg-[#080916] px-2.5 py-1.5 font-mono text-xs text-slate-200 focus:border-[#06b6d4] focus:outline-none"
                />
                <datalist id="crystal-model-presets">
                  {activeProviderMeta.modelPresets.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </datalist>
              </div>
            </div>

            {/* Footer action */}
            <div className="shrink-0 border-t border-[#1b1e36] p-4">
              <button
                onClick={() => void runSmartSplit()}
                disabled={smartSplitLoading || !crystalReady}
                className="w-full rounded-lg border border-[#06b6d4]/30 bg-[#06b6d4]/15 py-2 text-xs font-semibold text-[#67e8f9] transition-all hover:bg-[#06b6d4]/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {smartSplitLoading ? '✨ 正在智能分析…' : '✨ 开始智能语义拆分'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Undo/Success Toast component (AC4, AC5) */}
      {toast && toast.show && (
        <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex flex-col p-4 rounded-xl backdrop-blur-md shadow-2xl text-xs min-w-[320px] max-w-md animate-[fadeIn_150ms_ease-out] ${
          toast.type === 'success'
            ? 'bg-[#0c0e20]/95 border border-[#10b981]/30 text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.15)]'
            : 'bg-[#0c0e20]/90 border border-[#5e6ad2]/30 text-slate-200 shadow-[0_0_20px_rgba(94,106,210,0.15)]'
        }`}>
          <div className="flex items-center justify-between gap-4">
            <span className={`font-medium ${toast.type === 'success' ? 'text-emerald-300' : 'text-slate-300'}`}>
              {toast.message}
            </span>
            {toast.type === 'stitch' && canUndo && (
              <button
                onClick={handleUndo}
                className="text-[#06b6d4] hover:text-[#5e6ad2] font-semibold flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-[#06b6d4]/10 shrink-0"
                aria-label="撤销操作"
              >
                撤销 ↩️
              </button>
            )}
          </div>
          <div className="mt-2.5 w-full bg-[#1b1e36] h-1 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-100 ease-linear ${
                toast.type === 'success' ? 'bg-[#10b981]' : 'bg-[#06b6d4]'
              }`}
              style={{ width: `${(toast.countdown / 6000) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Float Toolbar component (AC6) */}
      <div
        className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 px-6 py-3.5 rounded-full bg-[#0c0e20]/95 border border-[#1b1e36] backdrop-blur-md shadow-2xl transition-all duration-300 transform ${
          selectedChapterIds.size >= 2 ? 'translate-y-0 opacity-100 font-sans' : 'translate-y-20 opacity-0 pointer-events-none'
        }`}
      >
        <span className="text-xs font-semibold text-slate-200">
          已选中 <span className="text-[#06b6d4] font-mono">{selectedChapterIds.size}</span> 个章节
        </span>
        <div className="h-4 w-px bg-[#1b1e36]" />
        <button
          onClick={() => setShowBulkModal(true)}
          className="text-xs bg-[#5e6ad2] hover:bg-[#5e6ad2]/80 text-white font-medium px-3.5 py-1.5 rounded-full transition-all flex items-center gap-1"
          aria-label="批量合并章节"
        >
          🔗 批量合并
        </button>
        <button
          onClick={() => setSelectedChapterIds(new Set())}
          className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded-full hover:bg-[#1b1e36] transition-all"
          aria-label="取消选择"
        >
          取消选择
        </button>
      </div>

      {/* Bulk Confirmation Modal (AC7) */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-[fadeIn_150ms_ease-out]">
          <div className="w-full max-w-md p-6 rounded-2xl bg-[#0c0e20]/95 border border-[#1b1e36] shadow-2xl space-y-5">
            <div className="flex items-center gap-2">
              <span className="text-base">🔗</span>
              <h3 className="text-sm font-semibold text-white">批量物理合并确认</h3>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed font-sans">
              确认合并选中的 <span className="text-[#06b6d4] font-semibold">{selectedChapterIds.size}</span> 个章节？此操作将按目录顺序物理拼接文本，且第一章无法被并入。
            </p>
            <div className="flex justify-end gap-3 text-xs pt-2">
              <button
                onClick={() => setShowBulkModal(false)}
                className="px-4 py-2 rounded-lg border border-[#1b1e36] hover:bg-[#1b1e36] text-slate-400 hover:text-white transition-colors"
                aria-label="取消合并"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setShowBulkModal(false);
                  handleBulkStitch();
                }}
                className="px-4 py-2 rounded-lg bg-[#5e6ad2] hover:bg-[#5e6ad2]/80 text-white font-medium transition-colors"
                aria-label="确认批量合并"
              >
                确认合并
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
