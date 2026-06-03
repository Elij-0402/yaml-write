import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel, type SplitMeta, type SplitStrategyId } from '../app/db';
import { useAppStore } from '../app/store';
import { getProviderMeta } from '../app/llmProviders';
import { getLlmConfigError, postWithLlmConfig, readApiErrorMessage } from '../app/llmClient';
import { rescoreSplit } from '../app/splitQuality';
import { parseNovelFile, resplit } from '../app/novelParser';
import { planStitch, planBulkStitch, planSplit, buildStitchBackup } from '../app/chapterOps';
import { DEFAULT_CUSTOM_REGEX, validateLineRegex } from '../app/splitRegex';
import ProviderCredentialsEditor from './ProviderCredentialsEditor';
import AppDialog from './AppDialog';
import AppNotice from './AppNotice';

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

// === Story 1.6: JIT 智能语义拆分 / Ollama 心跳 ===
const SMART_SPLIT_MIN_WORDS = 8000; // 分章置信度极低判定：分章数 <= 1 且总字数 >= 此阈值
const SMART_SPLIT_MAX_CHARS = 20000; // 发往后端的正文上限（前两万字）
const COMPATIBLE_MODEL_REGEX = /llama3|qwen2\.5|qwen2/i; // Ollama 兼容模型静默审计
const OLLAMA_OFFLINE_HINT =
  '未检测到可用的本地模型服务。请先启动 Ollama，或改用上方的云端模型配置。';
const OLLAMA_MODEL_MISSING_HINT =
  'Ollama 已连接，但未检测到兼容的 llama3 或 qwen2.5 模型。建议先在控制台运行 `ollama run qwen2.5` 拉取模型，或改用上方云端模型。';

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

async function computeSha256(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

export default function NovelUploader() {
  const { selectedNovelId, setSelectedNovelId, setManageMode, llmConfig } =
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
  const [toast, setToast] = useState<{
    show: boolean;
    message: string;
    countdown: number;
    type?: 'stitch' | 'success';
  } | null>(null);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [pendingResplitStrategy, setPendingResplitStrategy] = useState<SplitStrategyId | null>(null);

  // Story 1.5 State
  const [isSplitMode, setIsSplitMode] = useState(false);
  const [hoveredGapIndex, setHoveredGapIndex] = useState<number | null>(null);
  const [selectedMobileGapIndex, setSelectedMobileGapIndex] = useState<number | null>(null);
  const [isTearing, setIsTearing] = useState(false);
  const [splittingIndex, setSplittingIndex] = useState<number | null>(null);

  // Story 1.6 State — JIT 水晶配置卡 + Ollama 心跳 + 智能语义拆分推荐
  const [isCrystalOpen, setIsCrystalOpen] = useState(false);
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
  // 解析 Worker 的中止句柄：卸载时 abort，由 app/novelParser 内部 terminate + 清看门狗（替代旧的 worker/watchdog 双 ref）。
  const parserAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => parserAbortRef.current?.abort();
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

    const backup = buildStitchBackup(chapters, novelId, clonedAffected);

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

    const plan = planStitch(chapters, chapterId);
    if (!plan) return; // 首章不可前缝 / 未找到
    const curr = chapters.find((c) => c.id === plan.removeId)!;
    const prev = chapters.find((c) => c.id === plan.keepId)!;

    setProcessing(true);

    try {
      setCanUndo(backupStitchData(selectedNovelId, [prev, curr]));

      await new Promise((resolve) => setTimeout(resolve, 200));

      const sha = await computeSha256(plan.mergedContent);

      await db.transaction('rw', [db.chapters, db.novels], async () => {
        await db.chapters.update(plan.keepId, {
          content: plan.mergedContent,
          wordCount: plan.mergedContent.length,
          contentSha256: sha,
          mapStatus: 'pending'
        });

        await db.chapters.delete(plan.removeId);

        for (const entry of plan.reindex) {
          await db.chapters.update(entry.id, { chapterIndex: entry.chapterIndex });
        }

        const updatedChapters = await db.chapters.where('novelId').equals(selectedNovelId).toArray();
        await db.novels.update(selectedNovelId, {
          wordCount: updatedChapters.reduce((sum, c) => sum + c.wordCount, 0),
          // 手动剪/合并后即时重算切分质量 —— 否则 needs_review 永不刷新（死门 + 删数据陷阱）。同事务内写以保原子。
          ...rescoreSplit(updatedChapters, activeNovel?.splitMeta),
        });
      });

      setSelectedChapterIds(new Set());

      if (activeChapterId === plan.removeId) {
        setActiveChapterId(plan.keepId);
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
          // 撤销后同样重算，否则 splitStatus 会停留在前向操作写入的值。
          ...rescoreSplit(restoredChapters, activeNovel?.splitMeta),
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

    const plan = planBulkStitch(chapters, selectedChapterIds);
    if (plan.removeIds.length === 0) return;

    setProcessing(true);

    try {
      const affectedIds = new Set<string>([...plan.removeIds, ...plan.merges.map((m) => m.keepId)]);
      const affectedChapters = chapters.filter((c) => affectedIds.has(c.id));

      setCanUndo(backupStitchData(selectedNovelId, affectedChapters));

      await new Promise((resolve) => setTimeout(resolve, 200));

      // 各保留锚点合并后正文的 sha（async crypto，先于事务算好）。
      const shaByKeep = new Map<string, string>();
      for (const m of plan.merges) {
        shaByKeep.set(m.keepId, await computeSha256(m.mergedContent));
      }

      await db.transaction('rw', [db.chapters, db.novels], async () => {
        for (const m of plan.merges) {
          await db.chapters.update(m.keepId, {
            content: m.mergedContent,
            wordCount: m.mergedContent.length,
            contentSha256: shaByKeep.get(m.keepId),
            mapStatus: 'pending',
          });
        }

        for (const id of plan.removeIds) {
          await db.chapters.delete(id);
        }

        for (const entry of plan.reindex) {
          await db.chapters.update(entry.id, { chapterIndex: entry.chapterIndex });
        }

        const updatedChapters = await db.chapters.where('novelId').equals(selectedNovelId).toArray();
        await db.novels.update(selectedNovelId, {
          wordCount: updatedChapters.reduce((sum, c) => sum + c.wordCount, 0),
          // 手动剪/合并后即时重算切分质量 —— 否则 needs_review 永不刷新（死门 + 删数据陷阱）。同事务内写以保原子。
          ...rescoreSplit(updatedChapters, activeNovel?.splitMeta),
        });
      });

      setSelectedChapterIds(new Set());
      setActiveChapterId(null);

      setToast({
        show: true,
        message: `已批量缝合选中的 ${plan.removeIds.length} 个章节`,
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
    detecting: '识别文本编码与文件结构...',
    reading: '清洗文本并提取正文...',
    splitting: '按章节规则切分内容...',
    hashing: '计算内容指纹与一致性校验...',
    saving: '写入本地项目与章节索引...',
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
    const ac = new AbortController();
    parserAbortRef.current = ac;

    try {
      await ensureStorageCapacity(file);

      // Silently request storage persistence as per T3
      if (navigator.storage && navigator.storage.persist) {
        await navigator.storage.persist();
      }

      const { chapters: parsedChapters, splitMeta: computedSplitMeta, cleanedText, purifiedCount } =
        await parseNovelFile(file, {
          signal: ac.signal,
          onProgress: ({ stage, percent }) => {
            setUploadStage(stage as UploadStage);
            setUploadStageText(percent !== undefined ? `${percent}%` : '');
          },
        });

      setUploadStage('saving');
      setUploadStageText('');

      await db.transaction('rw', [db.novels, db.chapters], async () => {
        // Write to novels with camelCase fields
        await db.novels.add({
          id: novelId,
          name: novelName,
          wordCount: parsedChapters.reduce((sum, c) => sum + c.wordCount, 0),
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
        const chaptersToSave = parsedChapters.map((chapter) => ({
          id: crypto.randomUUID(),
          novelId,
          chapterIndex: chapter.chapterIndex,
          name: chapter.title,
          content: chapter.content,
          wordCount: chapter.wordCount,
          contentSha256: chapter.contentSha256,
          status: 'unparsed' as const,
          mapStatus: 'pending' as const,
        }));

        await db.chapters.bulkAdd(chaptersToSave);
      });

      setSelectedNovelId(novelId);
      resetChapterListView();
      // 导入后永远落到「校验切分」管理视图：先看见章节+质量再显式进 DNA —— 导入↔切分合为一条连续流。
      setManageMode(true);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // 卸载中止：静默
      setErrorMsg(err instanceof Error ? err.message : '解析或保存小说失败');
    } finally {
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

    const ac = new AbortController();
    parserAbortRef.current = ac;

    try {
      const { chapters: parsedChapters, splitMeta: computedSplitMeta } = await resplit(
        activeNovel.sourceTextCleaned,
        strategy,
        {
          signal: ac.signal,
          customRegex: strategy === 'custom' ? repairRegex : undefined,
          onProgress: ({ stage, percent }) => {
            setUploadStage(stage as UploadStage);
            setUploadStageText(percent !== undefined ? `${percent}%` : '');
          },
        },
      );

      setUploadStage('saving');
      setUploadStageText('');

      await db.transaction('rw', [db.novels, db.chapters], async () => {
        // Empty existing chapters first to prevent residue as per AC5
        await db.chapters.where('novelId').equals(activeNovel.id).delete();

        // Bulk add newly computed chapters with contentSha256
        const chaptersToSave = parsedChapters.map((chapter) => ({
          id: crypto.randomUUID(),
          novelId: activeNovel.id,
          chapterIndex: chapter.chapterIndex,
          name: chapter.title,
          content: chapter.content,
          wordCount: chapter.wordCount,
          contentSha256: chapter.contentSha256,
          status: 'unparsed' as const,
          mapStatus: 'pending' as const,
        }));

        await db.chapters.bulkAdd(chaptersToSave);

        // Update novel metadata
        await db.novels.update(activeNovel.id, {
          wordCount: parsedChapters.reduce((sum, c) => sum + c.wordCount, 0),
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
      } else {
        setToast({
          show: true,
          message: `重切完成：${computedSplitMeta.chapterCount} 章，置信度 ${Math.round(computedSplitMeta.confidence * 100)}%。`,
          countdown: 4000,
          type: 'success',
        });
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // 卸载中止：静默
      setErrorMsg(err instanceof Error ? err.message : '重分章引擎解析失败');
    } finally {
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
    setPendingResplitStrategy(strategy);
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

      const plan = planSplit(activeChapter, originalLineIndices[pIdx], chapters);

      const shaA = await computeSha256(plan.contentA);
      const shaB = await computeSha256(plan.contentB);

      const newChapterId = crypto.randomUUID();

      await db.transaction('rw', [db.chapters, db.novels], async () => {
        await db.chapters.update(activeChapter.id, {
          content: plan.contentA,
          wordCount: plan.contentA.length,
          contentSha256: shaA,
          status: 'unparsed',
          mapStatus: 'pending'
        });

        for (const entry of plan.reindex) {
          await db.chapters.update(entry.id, { chapterIndex: entry.chapterIndex });
        }

        const newChapter: Chapter = {
          id: newChapterId,
          novelId: selectedNovelId,
          chapterIndex: plan.newChapterIndex,
          name: plan.newName,
          content: plan.contentB,
          wordCount: plan.contentB.length,
          contentSha256: shaB,
          status: 'unparsed',
          mapStatus: 'pending'
        };
        await db.chapters.add(newChapter);

        const updatedChapters = await db.chapters.where('novelId').equals(selectedNovelId).toArray();
        await db.novels.update(selectedNovelId, {
          wordCount: updatedChapters.reduce((sum, c) => sum + c.wordCount, 0),
          // 手动剪/合并后即时重算切分质量 —— 否则 needs_review 永不刷新（死门 + 删数据陷阱）。同事务内写以保原子。
          ...rescoreSplit(updatedChapters, activeNovel?.splitMeta),
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
        className="atelier mx-auto w-full max-w-5xl rounded-[28px] border border-default bg-[linear-gradient(180deg,rgba(26,21,18,0.96),rgba(16,13,11,0.98))] p-8 shadow-[0_30px_80px_rgba(0,0,0,0.32)]"
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
      >
        <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".txt" className="hidden" />

        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="py-2">
            <div className="eyebrow">导入起点 · 工作流开场</div>
            <h1 className="atelier-h1" style={{ fontSize: 30 }}>把读过的书，整理成一条可继续创作的工作流。</h1>
            <p className="lede">导入 TXT 之后，系统会先做清洗与切分，再把可用章节送进 DNA 提取。整个过程都围绕同一条主线，不会让你在页面之间重新理解一遍产品。</p>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {[
                ['01', '导入文本', '识别编码、净化噪音，把原稿变成可处理的项目。'],
                ['02', '校验切分', '把异常章节和风险位置提前暴露，避免错误一路带到后面。'],
                ['03', '生成 DNA', '当结构可靠后，再交给模型提取骨架、题材与风格。'],
              ].map(([idx, title, desc]) => (
                <div key={idx} className="rounded-2xl border border-default bg-[rgba(26,21,18,0.72)] p-4">
                  <div className="font-mono text-[10px] tracking-[0.24em] text-muted">{idx}</div>
                  <div className="mt-2 text-sm text-primary">{title}</div>
                  <p className="mt-1 text-xs leading-6 text-secondary">{desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[24px] border border-[color:var(--vermilion-line)] bg-[linear-gradient(180deg,rgba(207,74,46,0.08),rgba(207,74,46,0.02))] p-5">
            <div className="text-[11px] uppercase tracking-[0.28em] text-vermilion" style={{ fontFamily: 'var(--font-mono)' }}>文件投入口</div>
            <p className="mt-2 text-sm leading-6 text-secondary">支持拖拽导入，也可以点按选择文件。导入完成后会直接进入切分校验台，不需要你再猜下一步该去哪。</p>
            <div
              onClick={() => fileInputRef.current?.click()}
              className={`relative mt-5 cursor-pointer overflow-hidden rounded-[22px] border border-dashed px-8 py-14 text-center transition-all duration-150 ${
                dragActive
                  ? 'border-[color:var(--vermilion)] bg-[color:var(--vermilion-soft)]'
                  : 'border-[color:var(--vermilion-line)] bg-black/10 hover:border-[color:var(--vermilion)]'
              }`}
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(207,74,46,0.14),transparent_55%)] opacity-80" />
              <div className="relative space-y-4">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[color:var(--vermilion-line)] bg-black/20 text-2xl text-primary">
                  文
                </div>
                <div>
                  <p className="text-sm font-medium text-primary" style={{ color: dragActive ? 'var(--vermilion)' : undefined }}>
                    {dragActive ? '松开鼠标，开始导入这本书' : '点击选择或拖拽 TXT 到这里'}
                  </p>
                  <p className="mt-2 text-xs leading-6 text-secondary">
                    支持 UTF-8 / GB18030 / BIG5 自适应识别，单文件 50MB 以内
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-secondary">
              <span className="rounded-full border border-default px-2.5 py-1">本地处理</span>
              <span className="rounded-full border border-default px-2.5 py-1">自动进入切分校验</span>
              <span className="rounded-full border border-default px-2.5 py-1">DNA 状态持续可见</span>
            </div>
          </div>
        </div>

        {uploading && (
          <div className="mt-6 rounded-[24px] border border-default bg-black/15 p-6">
            <div className="flex items-center gap-5">
              <div className="relative h-16 w-16 will-change-transform">
                <svg className="h-full w-full animate-[spin_6s_linear_infinite]" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="40" stroke="url(#vermilion-grad)" strokeWidth="3" strokeDasharray="180 60" fill="none" className="opacity-90" />
                  <circle cx="50" cy="50" r="29" stroke="url(#ink-grad)" strokeWidth="2.5" strokeDasharray="120 42" fill="none" className="opacity-80 origin-center animate-[spin_4s_linear_infinite_reverse]" />
                  <circle cx="50" cy="50" r="6" fill="#cf4a2e" className="animate-pulse motion-reduce:animate-none" />
                  <defs>
                    <linearGradient id="vermilion-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#cf4a2e" />
                      <stop offset="100%" stopColor="#f2c078" />
                    </linearGradient>
                    <linearGradient id="ink-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#8993a1" />
                      <stop offset="100%" stopColor="#efe6d6" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-primary">{stageLabelMap[uploadStage]}</p>
                <p className="text-xs leading-6 text-secondary">导入完成后会自动带你进入切分校验台，避免“已经进来了但不知道接下来去哪”的断层感。</p>
                {uploadStageText && <p className="text-xs font-mono tracking-wider text-vermilion">{uploadStageText}</p>}
              </div>
            </div>
          </div>
        )}

        {errorMsg && (
          <AppNotice tone="error" title="导入失败" className="mt-6 text-center">
            {errorMsg}
          </AppNotice>
        )}
      </div>
    );
  }

  // Chapter Review View
  return (
    <div className="flex h-[calc(100vh-8rem)] w-full overflow-hidden rounded-[28px] border border-default bg-[linear-gradient(180deg,rgba(26,21,18,0.97),rgba(16,13,11,0.99))] shadow-[0_30px_80px_rgba(0,0,0,0.32)]">
      {/* Left panel: outline tree */}
      <div className="flex h-full w-[360px] shrink-0 flex-col border-r border-default bg-[rgba(11,9,8,0.42)]">
        {/* Left header: info and settings */}
        <div className="shrink-0 space-y-4 border-b border-default p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-[0.22em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>切分校验 · 章节工作台</div>
              <h2 className="truncate text-sm font-semibold text-primary" title={activeNovel?.name || ''}>
              {activeNovel?.name}
              </h2>
            </div>
            <button
              onClick={() => setSelectedNovelId(null)}
              className="rounded-full border border-default px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:text-primary"
            >
              关闭
            </button>
          </div>
          <div className="rounded-2xl border border-default bg-black/10 p-3 text-[11px] font-mono leading-relaxed text-secondary">
            <div>{formatWordCount(activeNovel?.wordCount || 0)}字 · {chapters.length}章</div>
            <div>均字：{Math.round(derivedStats?.avgChapterChars ?? 0)}字/章</div>
            {!!activeNovel?.purifiedCount && activeNovel.purifiedCount > 0 && (
              <div className="text-emerald-400">已净化 {activeNovel.purifiedCount.toLocaleString()} 字噪点</div>
            )}
            {splitMeta && (
              <div className="mt-1.5">
                <span
                  className={`inline-block rounded-full px-2 py-1 text-[10px] font-medium ${
                    splitMeta.confidenceLevel === 'high'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : splitMeta.confidenceLevel === 'medium'
                      ? 'bg-amber-500/10 text-amber-400'
                      : 'bg-rose-500/10 text-rose-400'
                  }`}
                >
                  切分置信度 {splitMeta.confidenceLevel === 'high' ? '高' : splitMeta.confidenceLevel === 'medium' ? '中' : '低'} · {Math.round(splitMeta.confidence * 100)}%
                </span>
              </div>
            )}
          </div>

          {/* AC1: 分章置信度极低时滑入的智能语义拆分入口 */}
          {canSmartSplit && (
            <button
              onClick={handleSmartSplitClick}
              disabled={smartSplitLoading || processing}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)] px-2 py-2.5 text-xs font-semibold text-vermilion transition-all disabled:opacity-50"
              title="当切分质量过低时，借助模型推荐更合理的切开点"
            >
              {smartSplitLoading ? '✨ 正在智能分析…' : '✨ AI 辅助拆分'}
            </button>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {needsSmartRepair ? (
              <button
                onClick={() => void runResplit('auto_v2')}
                disabled={repairing}
                className="flex-1 rounded-xl border border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)] px-2 py-2 text-xs font-medium text-vermilion transition-all disabled:opacity-50"
              >
                {repairing ? '修复中...' : '先修风险章节'}
              </button>
            ) : (
              <button
                onClick={() => setManageMode(false)}
                className="flex-1 rounded-xl border border-default bg-secondary px-2 py-2 text-xs font-medium text-primary transition-all hover:border-[color:var(--vermilion-line)]"
              >
                返回 DNA 页面 →
              </button>
            )}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`px-2 py-1.5 rounded text-xs font-medium border transition-all ${
                showAdvanced
                  ? 'bg-secondary border-default text-primary'
                  : 'bg-transparent border-default text-secondary hover:text-primary'
              }`}
            >
              分章规则
            </button>
          </div>

          {/* Foldable Resplit settings */}
          {showAdvanced && (
            <div className="space-y-3 border-t border-default pt-2 animate-[fadeIn_150ms_ease-out]">
              <div className="flex items-center gap-2">
                <select
                  value={repairStrategy}
                  onChange={(e) => setRepairStrategy(e.target.value as SplitStrategyId)}
                  className="workspace-input flex-1 px-2 py-1 text-xs"
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
                  className="workspace-button px-3 py-1.5 text-xs disabled:opacity-30"
                >
                  执行
                </button>
              </div>
              {repairStrategy === 'custom' && (
                <div className="space-y-1">
                  <label className="font-mono text-[10px] text-muted">正则表达式</label>
                  <input
                    type="text"
                    value={repairRegex}
                    onChange={(e) => setRepairRegex(e.target.value)}
                    className="workspace-input p-1.5 text-xs font-mono"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Diagnostic info or progress bar */}
        {(uploading || repairing || errorMsg || needsSmartRepair) && (
          <div className="shrink-0 space-y-1 border-b border-default bg-black/10 p-3 text-xs">
            {needsSmartRepair && (
              <div className="flex items-center gap-1.5 font-mono text-amber-500">
                <span>● 先修风险章节再继续</span>
                {splitMeta && <span className="text-muted">({Math.round(splitMeta.confidence * 100)}% 置信度)</span>}
              </div>
            )}
            {reviewReasons.length > 0 && (
              <div className="truncate font-mono text-[10px] text-muted">
                原因: {reviewReasons.join(' · ')}
              </div>
            )}
            {(uploading || repairing) && (
              <div className="flex items-center gap-2 text-vermilion">
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
            placeholder="搜索章节标题..."
            className="w-full rounded-xl border border-default bg-black/10 px-3 py-2 text-xs text-primary transition-colors focus:border-[color:var(--vermilion-line)] focus:outline-none"
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
              
              let textClass = 'text-secondary hover:text-primary';
              let bgClass = 'hover:bg-[rgba(239,230,214,0.04)]';
              let borderClass = 'border-l-2 border-transparent';
              
              if (isSelected) {
                bgClass = 'bg-[color:var(--vermilion-soft)]';
                borderClass = 'border-l-2 border-[color:var(--vermilion)]';
                if (warningType === 'short') {
                  textClass = 'text-[#f59e0b] font-medium';
                } else if (warningType === 'long') {
                  textClass = 'text-blueprint font-medium';
                } else {
                  textClass = 'text-primary font-medium';
                }
              } else {
                if (warningType === 'short') {
                  textClass = 'text-[#f59e0b]/80 hover:text-[#f59e0b]';
                } else if (warningType === 'long') {
                  textClass = 'text-[color:rgba(137,147,161,0.82)] hover:text-blueprint';
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
                  className={`group flex items-center justify-between rounded px-3 py-2 text-xs transition-all duration-150 cursor-pointer ${bgClass} ${borderClass} focus:outline-none focus:ring-1 focus:ring-[color:var(--vermilion-line)]`}
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
                      className="mr-2 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-default bg-black/20 text-vermilion focus:ring-[color:var(--vermilion-line)] disabled:cursor-not-allowed"
                      aria-label={`选择第${chapter.chapterIndex}章`}
                    />
                    <span className="text-[#8a8f98] font-mono shrink-0 w-8">{chapter.chapterIndex}</span>
                    <span className={`truncate ${textClass}`}>{chapter.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 pl-2">
                    {/* DNA Sequencing State Badge or Hover Action */}
                    {chapter.mapStatus === 'mapping' ? (
                      <div className="flex items-center gap-1 text-cyan-400 font-mono text-[10px]">
                        <svg className="w-3 h-3 animate-spin text-cyan-400" viewBox="0 0 100 100">
                          <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="12" strokeDasharray="160 80" fill="none" />
                        </svg>
                        <span>[分析中...]</span>
                      </div>
                    ) : chapter.mapStatus === 'done' ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" title="已完成 DNA 提取">
                        🧬
                      </span>
                    ) : chapter.mapStatus === 'error' ? (
                      <div className="relative group/error shrink-0">
                        <span className="text-red-500 cursor-help" title={chapter.errorMsg || '解析失败'}>⚠️</span>
                        {chapter.errorMsg && (
                      <div className="absolute bottom-full right-0 z-50 mb-1 hidden w-48 break-all rounded-lg border border-red-500/30 bg-[rgba(16,13,11,0.94)] p-2 text-[10px] text-red-200 shadow-xl backdrop-blur-md group-hover/error:block whitespace-normal">
                            {chapter.errorMsg}
                          </div>
                        )}
                      </div>
                    ) : null}

                    {warningType === 'short' && (
                      <button
                        disabled={chapter.id === chapters[0]?.id || processing}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStitch(chapter.id);
                        }}
                        className="rounded border border-[#f59e0b]/20 bg-[#f59e0b]/10 px-1.5 py-0.5 text-[10px] text-[#f59e0b] opacity-0 transition-opacity hover:bg-[#f59e0b]/30 hover:text-white group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
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
                        className="rounded border border-[color:var(--blueprint)]/25 bg-[color:var(--blueprint-soft)] px-1.5 py-0.5 text-[10px] text-blueprint opacity-0 transition-opacity hover:bg-[rgba(137,147,161,0.22)] hover:text-primary group-hover:opacity-100 disabled:opacity-40"
                        title="帮我裁切本章"
                        aria-label="一键裁切"
                      >
                        ✂️ 裁切
                      </button>
                    )}
                    {warningType === 'long' && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--blueprint)]" title="字数极长警告" />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right panel: golden reader / empty state */}
      <div className="relative flex h-full flex-1 flex-col overflow-hidden bg-[rgba(6,5,4,0.36)]">
        {!activeChapter ? (
          <div className="flex flex-1 flex-col items-center justify-center space-y-6 p-8 text-center select-none">
            <div className="grid h-28 w-28 place-items-center rounded-full border border-[color:var(--vermilion-line)] bg-[radial-gradient(circle,rgba(207,74,46,0.18),transparent_60%)] text-3xl text-vermilion">
              章
            </div>

            <div className="max-w-sm space-y-2">
              <p className="text-sm font-medium text-primary">选择一章，开始校验它是否适合进入 DNA 提取</p>
              <p className="text-xs leading-relaxed text-secondary">
                左侧列表会持续显示字数异常、切分风险和 DNA 状态。你不需要来回切页确认系统在做什么。
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
            <div className="flex items-center justify-between border-b border-default bg-black/10 px-8 py-4 shrink-0 backdrop-blur-sm">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-widest text-vermilion">
                  {splitRecommendations.length > 0 ? '✨ AI 智能语义拆分建议' : '✂️ 游标剪刀交互裁切舱'}
                </div>
                <h3 className="mt-0.5 truncate text-sm font-semibold text-primary">
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
                    className="workspace-button-secondary workspace-button px-3 py-1.5 text-xs text-blueprint disabled:opacity-50"
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
                  className="workspace-button-secondary workspace-button px-3 py-1.5 text-xs"
                >
                  返回阅读模式
                </button>
              </div>
            </div>

            <div className="flex-1 flex h-full overflow-hidden relative">
              {/* Left Column: 裁剪仪表盘 (Split Control Dashboard) */}
              <div 
                className="flex h-full w-[260px] shrink-0 flex-col justify-between border-r border-default bg-[rgba(16,13,11,0.84)] p-5 text-xs backdrop-blur-sm"
              >
                <div className="space-y-6">
                  <div>
                    <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted">当前章节数据</h4>
                    <div className="space-y-1.5 font-mono text-secondary">
                      <div>总字数：{activeChapter.wordCount} 字</div>
                      <div>段落数：{paragraphs.length} 段</div>
                    </div>
                  </div>

                  <div>
                    <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted">裁切字数预测</h4>
                    {(hoveredGapIndex !== null || selectedMobileGapIndex !== null) ? (
                      <div className="space-y-3 rounded-lg border border-default bg-black/20 p-3 animate-[fadeIn_150ms_ease-out]">
                        <div className="space-y-1">
                          <div className="text-secondary">前半章 ({activeChapter.name}):</div>
                          <div className="font-mono font-semibold text-vermilion">{predictedWordsA} 字 ({percentageA}%)</div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-secondary">后半章 ({activeChapter.name} (下)):</div>
                          <div className="font-mono font-semibold text-blueprint">{predictedWordsB} 字 ({percentageB}%)</div>
                        </div>
                        <div className="mt-2 border-t border-default pt-2 text-[10px]">
                          {(predictedWordsA < 2000 || predictedWordsB < 2000) ? (
                            <span className="text-amber-500">⚠️ 分割后章节偏短</span>
                          ) : (
                            <span className="text-[#10b981]">✅ 比例非常协调</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-default bg-black/10 p-3 italic text-muted">
                        请将鼠标悬浮在右侧段落之间的缝隙上以预览裁切比例
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-mono text-[10px] uppercase tracking-wider text-muted">操作指南</h4>
                    <ul className="list-disc space-y-1 pl-4 leading-relaxed text-secondary">
                      <li>鼠标悬浮于段落行间缝隙</li>
                      <li>点击出现的 <span className="text-vermilion">“在此剪开”</span> 气泡</li>
                      <li>♿ 移动端：双击缝隙，或点击段落左侧的行号 `¶` 即可触发</li>
                      <li>裁切后支持 6 秒撤销</li>
                    </ul>
                  </div>
                </div>

                <div className="border-t border-default pt-4">
                  <div className="font-mono text-[10px] leading-relaxed text-muted">
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
                            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted opacity-50 transition-all select-none hover:bg-[color:var(--vermilion-soft)] hover:text-vermilion group-hover/paragraph:opacity-100"
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
                              <div className="my-1.5 w-full rounded-lg border border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)] p-2 backdrop-blur-sm animate-[fadeIn_200ms_ease-out]">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[11px] font-medium text-vermilion">💡 AI 推荐在此拆分</div>
                                    <div className="mt-0.5 text-[11px] leading-relaxed text-secondary">{rec.reason}</div>
                                    {rec.suggestedTitle && (
                                      <div className="mt-1 truncate font-mono text-[10px] text-muted">
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
                                    className="workspace-button shrink-0 self-center rounded-full px-3 py-1.5 text-[11px] disabled:opacity-40"
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
                                    ? 'animate-glow-fade border-[color:var(--vermilion)]'
                                    : 'border-[color:var(--vermilion-line)] opacity-30 group-hover/split-gap:animate-pulse group-hover/split-gap:border-[color:var(--vermilion)] group-hover/split-gap:opacity-100'
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
                                    className="absolute z-20 flex items-center gap-1 rounded-full border border-[color:var(--vermilion-line)] bg-[rgba(16,13,11,0.92)] px-3 py-1 text-[10px] font-semibold text-primary shadow-[0_0_15px_rgba(207,74,46,0.22)] backdrop-blur-md transition-all duration-200 cursor-pointer pointer-events-auto"
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
            <div className="flex items-center justify-between border-b border-default bg-black/10 px-8 py-4 shrink-0 backdrop-blur-sm">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  Chapter {activeChapter.chapterIndex}
                </div>
                <h3 className="mt-0.5 truncate text-sm font-semibold text-primary">
                  {activeChapter.name}
                </h3>
              </div>
              <div className="flex items-center gap-4">
                {activeChapter.wordCount > 12000 && (
                  <button
                    onClick={() => setIsSplitMode(true)}
                    disabled={processing}
                    className="workspace-button-secondary workspace-button gap-1 px-3 py-1.5 text-xs text-blueprint"
                  >
                    ✂️ 帮我裁切
                  </button>
                )}
                <div className="shrink-0 font-mono text-xs text-secondary">
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
                <div className="flex items-start gap-2.5 rounded-xl border border-[color:var(--blueprint)]/20 bg-[color:var(--blueprint-soft)] p-3.5 text-xs leading-relaxed text-primary shadow-lg shadow-black/40 backdrop-blur-md animate-[fadeIn_150ms_ease-out]">
                  <span className="text-base shrink-0">✂️</span>
                  <div className="flex-1 flex justify-between items-center gap-4">
                    <div>
                      <span className="font-semibold">本章字数过长（含有 {activeChapter.wordCount} 字）。</span>
                      建议先手动裁切本章，再继续做 DNA 提取与后续创作。
                    </div>
                    <button
                      onClick={() => setIsSplitMode(true)}
                      disabled={processing}
                      className="workspace-button px-3 py-1.5 text-xs"
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

        {/* AC1: 模型配置卡 — 右侧滑入式 */}
        <div
          className={`absolute right-0 top-0 z-30 h-full w-[400px] transition-transform duration-[400ms] ${
            isCrystalOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
          }`}
          style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
          aria-hidden={!isCrystalOpen}
        >
          <div className="flex h-full flex-col border-l border-default bg-[rgba(18,14,12,0.94)] shadow-[0_0_40px_rgba(0,0,0,0.55)] backdrop-blur-md">
            {/* Totem header */}
            <div className="relative shrink-0 overflow-hidden border-b border-default p-5">
              <svg className="pointer-events-none absolute -right-6 -top-6 h-40 w-40 opacity-20" viewBox="0 0 100 100" fill="none">
                <polygon points="50,8 86,30 86,70 50,92 14,70 14,30" stroke="var(--vermilion)" strokeWidth="0.6" />
                <polygon points="50,24 72,37 72,63 50,76 28,63 28,37" stroke="var(--blueprint)" strokeWidth="0.5" />
                <line x1="50" y1="8" x2="50" y2="92" stroke="var(--vermilion)" strokeWidth="0.3" />
                <line x1="14" y1="30" x2="86" y2="70" stroke="var(--blueprint)" strokeWidth="0.3" />
                <line x1="86" y1="30" x2="14" y2="70" stroke="var(--blueprint)" strokeWidth="0.3" />
              </svg>
              <div className="relative flex items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-vermilion">Model Config</div>
                  <h3 className="mt-0.5 text-sm font-semibold text-primary">模型配置</h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-secondary">配置云端 API Key，或确认本地 Ollama 已就绪，然后再执行 AI 辅助拆分。</p>
                </div>
                <button
                  onClick={() => setIsCrystalOpen(false)}
                  className="shrink-0 rounded border border-default px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted hover:text-primary"
                >
                  关闭
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <ProviderCredentialsEditor
                variant="crystal"
                providerSelector="tabs"
                apiKeyLabel="云端模型 API Key"
                keyHelpText="🔒 密钥仅以混淆形式存储于本地浏览器，绝不上传服务器。"
                ollamaSlot={
                  /* AC3/AC4: 本地 Ollama 心跳在线状态点 + 模型审计引导 */
                  <div className="space-y-2 rounded-lg border border-default bg-black/10 p-3">
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
                      <span className="text-xs font-medium text-primary">
                        {ollamaStatus === 'online'
                          ? 'Ollama 已连接'
                          : ollamaStatus === 'checking'
                          ? '正在检查 Ollama…'
                          : ollamaStatus === 'unknown'
                          ? '待检查'
                          : 'Ollama 未就绪'}
                      </span>
                    </div>
                    {ollamaMessage && <p className="text-[11px] leading-relaxed text-secondary">{ollamaMessage}</p>}
                  </div>
                }
              />
            </div>

            {/* Footer action */}
            <div className="shrink-0 border-t border-default p-4">
              <button
                onClick={() => void runSmartSplit()}
                disabled={smartSplitLoading || !crystalReady}
                className="workspace-button w-full py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                {smartSplitLoading ? '✨ 正在智能分析…' : '✨ 开始 AI 辅助拆分'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Undo/Success Toast component (AC4, AC5) */}
      {toast && toast.show && (
        <div className={`fixed bottom-8 left-1/2 z-50 flex min-w-[320px] max-w-md -translate-x-1/2 flex-col rounded-xl p-4 text-xs shadow-2xl backdrop-blur-md animate-[fadeIn_150ms_ease-out] ${
          toast.type === 'success'
            ? 'border border-[#10b981]/30 bg-[rgba(16,13,11,0.96)] text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.15)]'
            : 'border border-[color:var(--vermilion-line)] bg-[rgba(16,13,11,0.96)] text-secondary shadow-[0_0_20px_rgba(207,74,46,0.16)]'
        }`}>
          <div className="flex items-center justify-between gap-4">
            <span className={`font-medium ${toast.type === 'success' ? 'text-emerald-300' : 'text-slate-300'}`}>
              {toast.message}
            </span>
            {toast.type === 'stitch' && canUndo && (
              <button
                onClick={handleUndo}
                className="flex shrink-0 items-center gap-1 rounded px-2 py-1 font-semibold text-vermilion transition-colors hover:bg-[color:var(--vermilion-soft)] hover:text-primary"
                aria-label="撤销操作"
              >
                撤销 ↩️
              </button>
            )}
          </div>
          <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-black/20">
            <div
              className={`h-full transition-all duration-100 ease-linear ${
                toast.type === 'success' ? 'bg-[#10b981]' : 'bg-[color:var(--vermilion)]'
              }`}
              style={{ width: `${(toast.countdown / 6000) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Float Toolbar component (AC6) */}
      <div
        className={`fixed bottom-8 left-1/2 z-40 flex -translate-x-1/2 transform items-center gap-4 rounded-full border border-default bg-[rgba(16,13,11,0.95)] px-6 py-3.5 shadow-2xl backdrop-blur-md transition-all duration-300 ${
          selectedChapterIds.size >= 2 ? 'translate-y-0 opacity-100 font-sans' : 'translate-y-20 opacity-0 pointer-events-none'
        }`}
      >
        <span className="text-xs font-semibold text-primary">
          已选中 <span className="font-mono text-vermilion">{selectedChapterIds.size}</span> 个章节
        </span>
        <div className="h-4 w-px bg-black/20" />
        <button
          onClick={() => setShowBulkModal(true)}
          className="workspace-button flex items-center gap-1 rounded-full px-3.5 py-1.5 text-xs"
          aria-label="批量合并章节"
        >
          🔗 批量合并
        </button>
        <button
          onClick={() => setSelectedChapterIds(new Set())}
          className="rounded-full px-3 py-1.5 text-xs text-secondary transition-all hover:bg-black/10 hover:text-primary"
          aria-label="取消选择"
        >
          取消选择
        </button>
      </div>

      {/* Bulk Confirmation Modal (AC7) */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-[fadeIn_150ms_ease-out]">
          <div className="w-full max-w-md space-y-5 rounded-2xl border border-default bg-[rgba(16,13,11,0.96)] p-6 shadow-2xl">
            <div className="flex items-center gap-2">
              <span className="text-base">🔗</span>
              <h3 className="text-sm font-semibold text-primary">批量物理合并确认</h3>
            </div>
            <p className="font-sans text-xs leading-relaxed text-secondary">
              确认合并选中的 <span className="font-semibold text-vermilion">{selectedChapterIds.size}</span> 个章节？此操作将按目录顺序物理拼接文本，且第一章无法被并入。
            </p>
            <div className="flex justify-end gap-3 text-xs pt-2">
              <button
                onClick={() => setShowBulkModal(false)}
                className="workspace-button workspace-button-secondary px-4 py-2 text-xs"
                aria-label="取消合并"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setShowBulkModal(false);
                  handleBulkStitch();
                }}
                className="workspace-button px-4 py-2 text-xs"
                aria-label="确认批量合并"
              >
                确认合并
              </button>
            </div>
          </div>
        </div>
      )}

      <AppDialog
        open={Boolean(pendingResplitStrategy)}
        title="重新切分这本书？"
        description="系统会覆盖当前章节数据，并清空现有 DNA 进度，然后基于新的规则重新生成章节结构。"
        confirmLabel="确认重切"
        onClose={() => setPendingResplitStrategy(null)}
        onConfirm={() => {
          const strategy = pendingResplitStrategy;
          setPendingResplitStrategy(null);
          if (strategy) void doResplit(strategy);
        }}
      />
    </div>
  );
}
