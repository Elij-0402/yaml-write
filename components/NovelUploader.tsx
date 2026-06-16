import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Loader2, Sparkles, Link2, Scissors, Dna, AlertCircle, AlertTriangle, Check, Undo2, X } from 'lucide-react';
import { db, type Chapter, type Novel, type SplitStatus, type SplitStrategyId } from '../app/db';
import { isExtracting } from '../app/dnaState';
import { useAppStore } from '../app/store';
import { getProviderMeta } from '../app/llmProviders';
import { getLlmConfigError, postWithLlmConfig, readApiErrorMessage } from '../app/llmClient';
import { rescoreSplit } from '../app/splitQuality';
import { resplit } from '../app/novelParser';
import { planBlobPresplit } from '../app/blobPresplit';
import { planStitch, planBulkStitch, planSplit, buildStitchBackup } from '../app/chapterOps';
import { DEFAULT_CUSTOM_REGEX, validateLineRegex } from '../app/splitRegex';
import { OVERSIZED_CHAPTER_CHARS } from '../app/dnaRouting';
import { formatWordCount, sha256Hex } from '../app/util';
import ProviderCredentialsEditor from './ProviderCredentialsEditor';
import AppDialog from './AppDialog';
import { useFocusTrap } from '../app/useFocusTrap';

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

// 章节校验台（切分复核）：导入由 LibraryView 负责，本组件只在已选中作品时被 NovelWorkspace 的「章节校验」tab 挂载。
export default function NovelUploader() {
  const { selectedNovelId, setManageMode, llmConfig } =
    useAppStore();
  const activeProvider = llmConfig.activeProvider;
  const activeProviderMeta = getProviderMeta(activeProvider);
  const activeProfile = llmConfig.providerProfiles[activeProvider];

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

  // Story 1.6 State — JIT 配置卡 + Ollama 心跳 + 智能语义拆分推荐
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

  // 解析 Worker 的中止句柄：卸载时 abort，由 app/novelParser 内部 terminate + 清看门狗。
  const parserAbortRef = useRef<AbortController | null>(null);
  // 批量合并确认弹窗的焦点陷阱容器。
  const bulkModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(bulkModalRef, showBulkModal);

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

  // Story 1.6 derived — 智能语义拆分入口判定 / 配置卡就绪态 / 推荐点索引
  const oversizedChapter = chapters.find((c) => c.wordCount > OVERSIZED_CHAPTER_CHARS) || null;
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
  // 仅在配置卡打开且选用 Ollama 时轮询，避免无谓的后台请求。
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

      const sha = await sha256Hex(plan.mergedContent);

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
        shaByKeep.set(m.keepId, await sha256Hex(m.mergedContent));
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

  const doResplit = async (strategy: SplitStrategyId) => {
    if (!activeNovel || repairing) return;
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

      // 超长 blob 自动预切（同上传路径）：切成 ≤12k 片，杜绝砍尾 + 清掉「超大章节」误锁；预切后就地 rescore。
      const presplit = planBlobPresplit(parsedChapters);
      const effectiveChapters = presplit.chapters;
      const { splitStatus: effSplitStatus, splitMeta: effSplitMeta } = presplit.didSplit
        ? rescoreSplit(
            effectiveChapters.map((c) => ({ name: c.title, wordCount: c.wordCount, chapterIndex: c.chapterIndex })),
            computedSplitMeta,
          )
        : { splitStatus: (computedSplitMeta.confidenceLevel === 'low' ? 'needs_review' : 'ok') as SplitStatus, splitMeta: computedSplitMeta };

      await db.transaction('rw', [db.novels, db.chapters], async () => {
        // Empty existing chapters first to prevent residue as per AC5
        await db.chapters.where('novelId').equals(activeNovel.id).delete();

        // Bulk add newly computed chapters with contentSha256
        const chaptersToSave = effectiveChapters.map((chapter) => ({
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
          wordCount: effectiveChapters.reduce((sum, c) => sum + c.wordCount, 0),
          splitStatus: effSplitStatus,
          splitMeta: effSplitMeta,
          analysisStatus: 'idle',
          mapProgress: { total: 0, current: 0 },
          dnaCard: null,
        });
      });

      resetChapterListView();
      setSelectedChapterIds(new Set());
      if (effSplitMeta.confidenceLevel === 'low') {
        setToast({
          show: true,
          message: '重切后置信度仍偏低，可改用「分章规则」自定义正则，或用智能语义拆分。',
          countdown: 6000,
        });
      } else {
        setToast({
          show: true,
          message: `重切完成：${effSplitMeta.chapterCount} 章，置信度 ${Math.round(effSplitMeta.confidence * 100)}%。`,
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
    if (!activeNovel || repairing) return;
    if (isExtracting(activeNovel)) {
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

      const shaA = await sha256Hex(plan.contentA);
      const shaB = await sha256Hex(plan.contentB);

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

  // AC1: 未配置当前 Provider 的钥匙（或 Ollama 未就绪）则滑入配置卡，否则直接拆分。
  const handleSmartSplitClick = () => {
    if (!crystalReady || getLlmConfigError(llmConfig)) {
      setIsCrystalOpen(true);
      return;
    }
    void runSmartSplit();
  };

  const confidenceTone = splitMeta
    ? splitMeta.confidenceLevel === 'high' ? 'text-success'
      : splitMeta.confidenceLevel === 'medium' ? 'text-fg-muted'
      : 'text-danger'
    : 'text-fg-muted';

  // ============================ 章节校验台 ============================
  return (
    <div className="flex h-full w-full overflow-hidden rounded-lg border border-line bg-canvas">
      {/* 左栏：大纲树 + 工具 */}
      <div className="flex h-full w-[320px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="shrink-0 space-y-3 border-b border-line p-4">
          <div className="eyebrow">切分校验 · 章节工作台</div>

          <div className="rounded-md border border-line bg-surface p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
            <div>{formatWordCount(activeNovel?.wordCount || 0)} 字 · {chapters.length} 章</div>
            <div>均字 {Math.round(derivedStats?.avgChapterChars ?? 0)} 字/章</div>
            {!!activeNovel?.purifiedCount && activeNovel.purifiedCount > 0 && (
              <div className="text-success">已净化 {activeNovel.purifiedCount.toLocaleString()} 字噪点</div>
            )}
            {splitMeta && (
              <div className={`mt-1.5 ${confidenceTone}`}>
                切分置信度 {splitMeta.confidenceLevel === 'high' ? '高' : splitMeta.confidenceLevel === 'medium' ? '中' : '低'} · {Math.round(splitMeta.confidence * 100)}%
              </div>
            )}
          </div>

          {/* 智能语义拆分入口 */}
          {canSmartSplit && (
            <button onClick={handleSmartSplitClick} disabled={smartSplitLoading || processing} className="btn btn-secondary w-full gap-1.5" title="当切分质量过低时，借助模型推荐更合理的切开点">
              <Sparkles size={14} /> {smartSplitLoading ? '正在智能分析…' : 'AI 辅助拆分'}
            </button>
          )}

          {/* 动作行 */}
          <div className="flex gap-2">
            {needsSmartRepair ? (
              <button onClick={() => void runResplit('auto_v2')} disabled={repairing} className="btn btn-secondary flex-1">
                {repairing ? '修复中…' : '先修风险章节'}
              </button>
            ) : (
              <button onClick={() => setManageMode(false)} className="btn btn-secondary flex-1 gap-1.5"><Dna size={14} /> 查看 DNA</button>
            )}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`btn btn-sm ${showAdvanced ? 'btn-secondary' : 'btn-ghost'}`}
            >
              分章规则
            </button>
          </div>

          {/* 折叠的重切设置 */}
          {showAdvanced && (
            <div className="space-y-2.5 border-t border-line pt-3">
              <div className="flex items-center gap-2">
                <select value={repairStrategy} onChange={(e) => setRepairStrategy(e.target.value as SplitStrategyId)} className="input flex-1 text-xs">
                  <option value="auto_v2">智能自动采信</option>
                  <option value="zh_strict">中文严格</option>
                  <option value="zh_extended">中文扩展</option>
                  <option value="mixed">混合</option>
                  <option value="en_basic">英文</option>
                  <option value="custom">自定义</option>
                </select>
                <button onClick={() => void runResplit(repairStrategy)} disabled={repairing} className="btn btn-primary btn-sm">执行</button>
              </div>
              {repairStrategy === 'custom' && (
                <div className="space-y-1">
                  <label className="font-mono text-[10px] text-fg-subtle">正则表达式</label>
                  <input type="text" value={repairRegex} onChange={(e) => setRepairRegex(e.target.value)} className="input text-xs font-mono" />
                </div>
              )}
            </div>
          )}
        </div>

        {/* 诊断 / 进度 */}
        {(repairing || errorMsg || needsSmartRepair) && (
          <div className="shrink-0 space-y-1 border-b border-line bg-surface p-3 text-xs">
            {needsSmartRepair && (
              <div className="flex items-center gap-1.5 font-mono text-fg-muted">
                <span>● 先修风险章节再继续</span>
                {splitMeta && <span className="text-fg-subtle">({Math.round(splitMeta.confidence * 100)}% 置信度)</span>}
              </div>
            )}
            {reviewReasons.length > 0 && (
              <div className="truncate font-mono text-[10px] text-fg-subtle">原因：{reviewReasons.join(' · ')}</div>
            )}
            {repairing && (
              <div className="flex items-center gap-2 text-accent-ink">
                <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
                <span className="font-mono">{stageLabelMap[uploadStage]} {uploadStageText}</span>
              </div>
            )}
            {errorMsg && (
              <div className="flex items-start gap-1.5 font-mono leading-relaxed text-danger" title={errorMsg}>
                <AlertCircle size={13} className="mt-px shrink-0" /> <span className="truncate">{errorMsg}</span>
              </div>
            )}
          </div>
        )}

        {/* 搜索 */}
        <div className="shrink-0 border-b border-line p-3">
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="搜索章节标题…" className="input text-xs" />
        </div>

        {/* 大纲树 */}
        <div className={`flex-1 space-y-0.5 overflow-y-auto p-2 ${processing ? 'pointer-events-none opacity-60' : ''}`} role="tree" aria-label="章节大纲树">
          {filteredChapters.length === 0 ? (
            <p className="p-6 text-center font-mono text-xs text-fg-subtle">未找到匹配的章节</p>
          ) : (
            filteredChapters.map((chapter) => {
              const isSelected = activeChapterId === chapter.id;
              const wordCount = chapter.wordCount;
              let warningType: 'short' | 'long' | 'normal' = 'normal';
              if (wordCount < 120) warningType = 'short';
              else if (wordCount > 12000) warningType = 'long';

              return (
                <div
                  key={chapter.id}
                  role="treeitem"
                  aria-selected={isSelected}
                  aria-label={`第${chapter.chapterIndex}章：${chapter.name}，字数${chapter.wordCount}字`}
                  tabIndex={0}
                  onClick={() => { if (!processing) setActiveChapterId(chapter.id); }}
                  onKeyDown={(e) => { if (!processing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setActiveChapterId(chapter.id); } }}
                  className={`group flex cursor-pointer items-center justify-between rounded-md border-l-2 px-3 py-2 text-xs transition-colors ${
                    isSelected ? 'border-accent bg-raised' : 'border-transparent hover:bg-raised'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedChapterIds.has(chapter.id)}
                      disabled={processing}
                      onChange={(e) => {
                        e.stopPropagation();
                        if (processing) return;
                        setSelectedChapterIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id);
                          return next;
                        });
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[color:var(--accent)] disabled:cursor-not-allowed"
                      aria-label={`选择第${chapter.chapterIndex}章`}
                    />
                    <span className="w-7 shrink-0 font-mono text-fg-subtle">{chapter.chapterIndex}</span>
                    <span className={`truncate ${isSelected ? 'font-medium text-fg' : 'text-fg-muted group-hover:text-fg'}`}>{chapter.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 pl-2">
                    {chapter.mapStatus === 'mapping' ? (
                      <Loader2 size={12} className="animate-spin text-accent-ink motion-reduce:animate-none" />
                    ) : chapter.mapStatus === 'done' ? (
                      <Dna size={13} className="text-success" />
                    ) : chapter.mapStatus === 'error' ? (
                      <span title={chapter.errorMsg || '解析失败'}><AlertCircle size={13} className="text-danger" /></span>
                    ) : null}

                    {warningType === 'short' && (
                      <button
                        disabled={chapter.id === chapters[0]?.id || processing}
                        onClick={(e) => { e.stopPropagation(); handleStitch(chapter.id); }}
                        className="flex items-center gap-0.5 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted opacity-0 transition hover:border-fg-subtle hover:text-fg group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                        title={chapter.id === chapters[0]?.id ? '第一章无法向前缝合' : '将本章物理缝合至上一章'}
                        aria-label="缝合至上一章"
                      ><Link2 size={11} /> 缝合</button>
                    )}
                    <span className={`font-mono text-[10px] tabular-nums ${isSelected ? 'text-fg-muted' : 'text-fg-subtle'}`}>{wordCount}</span>
                    {warningType === 'short' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" title="字数极少警告" />}
                    {warningType === 'long' && (
                      <button
                        disabled={processing}
                        onClick={(e) => { e.stopPropagation(); setActiveChapterId(chapter.id); setIsSplitMode(true); }}
                        className="flex items-center gap-0.5 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted opacity-0 transition hover:border-fg-subtle hover:text-fg group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-40"
                        title="帮我裁切本章"
                        aria-label="裁切本章"
                      ><Scissors size={11} /> 裁切</button>
                    )}
                    {warningType === 'long' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" title="字数极长警告" />}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 右栏：阅读 / 裁切 / 空态 */}
      <div className="relative flex h-full flex-1 flex-col overflow-hidden bg-canvas">
        {!activeChapter ? (
          <div className="flex flex-1 select-none flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-full border border-line bg-panel text-fg-subtle">
              <Scissors size={20} />
            </div>
            <div className="max-w-sm space-y-2">
              <p className="text-sm font-medium text-fg">选择一章，校验它是否适合进入 DNA 提取</p>
              <p className="text-xs leading-relaxed text-fg-muted">左侧列表持续显示字数异常、切分风险和 DNA 状态。你不需要来回切页确认系统在做什么。</p>
            </div>
          </div>
        ) : isSplitMode || splitRecommendations.length > 0 ? (
          /* 双栏裁切面板（手动剪刀 或 AI 智能语义拆分建议） */
          <div key={`split-${activeChapter.id}`} className="flex h-full flex-1 flex-col overflow-hidden view-enter">
            <style>{`
              @keyframes tearUp { 0% { transform: translateY(0); opacity: 1; } 100% { transform: translateY(-4px); opacity: 0.5; } }
              @keyframes tearDown { 0% { transform: translateY(0); opacity: 1; } 100% { transform: translateY(4px); opacity: 0.5; } }
              @keyframes glowFade { 0% { height: 1px; opacity: 1; } 100% { height: 8px; opacity: 0; } }
              .animate-tear-up { animation: tearUp 300ms cubic-bezier(0.16,1,0.3,1) forwards; }
              .animate-tear-down { animation: tearDown 300ms cubic-bezier(0.16,1,0.3,1) forwards; }
              .animate-glow-fade { animation: glowFade 300ms cubic-bezier(0.16,1,0.3,1) forwards; }
              @media (prefers-reduced-motion: reduce) {
                .animate-tear-up, .animate-tear-down { animation: none; opacity: 0.85; }
                .animate-glow-fade { animation: none; opacity: 0; }
              }
            `}</style>

            <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-6 py-3.5">
              <div className="min-w-0">
                <div className="eyebrow flex items-center gap-1.5">
                  {splitRecommendations.length > 0 ? <><Sparkles size={12} /> AI 智能语义拆分建议</> : <><Scissors size={12} /> 交互裁切舱</>}
                </div>
                <h3 className="mt-0.5 truncate text-sm font-semibold text-fg">
                  {splitRecommendations.length > 0 ? `已推荐 ${splitRecommendations.length} 处切开点：${activeChapter.name}` : `正在裁切：${activeChapter.name}`}
                </h3>
              </div>
              <div className="flex items-center gap-2">
                {canSmartSplit && (
                  <button onClick={handleSmartSplitClick} disabled={smartSplitLoading || processing} className="btn btn-secondary btn-sm gap-1.5">
                    <Sparkles size={13} /> {smartSplitLoading ? '分析中…' : splitRecommendations.length > 0 ? '重新推荐' : '智能语义拆分'}
                  </button>
                )}
                <button
                  onClick={() => { setIsSplitMode(false); setHoveredGapIndex(null); setSelectedMobileGapIndex(null); setSplitRecommendations([]); }}
                  className="btn btn-ghost btn-sm"
                >返回阅读</button>
              </div>
            </div>

            <div className="relative flex h-full flex-1 overflow-hidden">
              {/* 裁切仪表盘 */}
              <div className="flex h-full w-[240px] shrink-0 flex-col justify-between border-r border-line bg-panel p-5 text-xs">
                <div className="space-y-6">
                  <div>
                    <h4 className="eyebrow mb-2">当前章节数据</h4>
                    <div className="space-y-1.5 font-mono text-fg-muted">
                      <div>总字数 {activeChapter.wordCount} 字</div>
                      <div>段落数 {paragraphs.length} 段</div>
                    </div>
                  </div>
                  <div>
                    <h4 className="eyebrow mb-2">裁切字数预测</h4>
                    {(hoveredGapIndex !== null || selectedMobileGapIndex !== null) ? (
                      <div className="card space-y-3 p-3">
                        <div className="space-y-1">
                          <div className="text-fg-muted">前半章：</div>
                          <div className="font-mono font-semibold text-fg">{predictedWordsA} 字 ({percentageA}%)</div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-fg-muted">后半章：</div>
                          <div className="font-mono font-semibold text-fg">{predictedWordsB} 字 ({percentageB}%)</div>
                        </div>
                        <div className="border-t border-line pt-2 text-[10px]">
                          {(predictedWordsA < 2000 || predictedWordsB < 2000)
                            ? <span className="flex items-center gap-1 text-danger"><AlertTriangle size={11} /> 分割后章节偏短</span>
                            : <span className="flex items-center gap-1 text-success"><Check size={11} /> 比例协调</span>}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-md border border-line bg-surface p-3 italic text-fg-subtle">悬浮在右侧段落之间的缝隙上预览裁切比例</div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <h4 className="eyebrow">操作指南</h4>
                    <ul className="list-disc space-y-1 pl-4 leading-relaxed text-fg-muted">
                      <li>鼠标悬浮于段落行间缝隙</li>
                      <li>点击出现的「在此剪开」气泡</li>
                      <li>移动端：双击缝隙，或点段落左侧行号</li>
                      <li>裁切后支持 6 秒撤销</li>
                    </ul>
                  </div>
                </div>
                <div className="border-t border-line pt-4 font-mono text-[10px] leading-relaxed text-fg-subtle">IndexedDB 本地原子事务保护</div>
              </div>

              {/* 段落列表 */}
              <div className="relative flex-1 overflow-y-auto px-8 py-6">
                <div className="mx-auto max-w-2xl space-y-2 py-4">
                  {paragraphs.map((pText, pIdx) => {
                    const isTearingUp = isTearing && splittingIndex !== null && pIdx <= splittingIndex;
                    const isTearingDown = isTearing && splittingIndex !== null && pIdx > splittingIndex;
                    const isGlowFade = isTearing && splittingIndex === pIdx;
                    const rec = recByIndex[pIdx];
                    return (
                      <React.Fragment key={pIdx}>
                        <div className={`group/paragraph relative flex items-start gap-4 py-2 transition-all duration-300 ${isTearingUp ? 'animate-tear-up' : ''} ${isTearingDown ? 'animate-tear-down' : ''}`}>
                          <button
                            onClick={() => { if (!processing) setSelectedMobileGapIndex(pIdx); }}
                            className="shrink-0 select-none rounded px-1.5 py-0.5 font-mono text-[10px] text-fg-subtle opacity-50 transition hover:bg-raised hover:text-fg group-hover/paragraph:opacity-100"
                            title="激活本段落后的剪开气泡"
                          >¶ {(pIdx + 1).toString().padStart(2, '0')}</button>
                          <p className="flex-1 select-text whitespace-pre-wrap text-sm leading-[1.8] text-fg">{pText}</p>
                        </div>

                        {pIdx < paragraphs.length - 1 && (
                          <div
                            onMouseEnter={() => { if (!processing) setHoveredGapIndex(pIdx); }}
                            onMouseLeave={() => { if (!processing) setHoveredGapIndex(null); }}
                            onDoubleClick={() => { if (!processing) handleSplitAtParagraph(pIdx); }}
                            className={`group/split-gap relative z-10 flex w-full items-center justify-center ${rec ? '' : 'h-6 cursor-pointer'}`}
                          >
                            {rec ? (
                              <div className="my-1.5 w-full rounded-md border border-line bg-surface p-2.5 view-enter">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1 text-[11px] font-medium text-fg"><Sparkles size={12} className="text-accent-ink" /> AI 推荐在此拆分</div>
                                    <div className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">{rec.reason}</div>
                                    {rec.suggestedTitle && <div className="mt-1 truncate font-mono text-[10px] text-fg-subtle">下半章建议标题：{rec.suggestedTitle}</div>}
                                  </div>
                                  <button onClick={(e) => { e.stopPropagation(); if (!processing) handleSplitAtParagraph(pIdx); }} disabled={processing} className="btn btn-primary btn-sm shrink-0 gap-1"><Scissors size={12} /> 在此拆分</button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className={`h-px w-full border-t border-dashed transition-all duration-150 ${isGlowFade ? 'animate-glow-fade border-accent' : 'border-line opacity-40 group-hover/split-gap:border-accent group-hover/split-gap:opacity-100'}`} />
                                {(!isTearing && (hoveredGapIndex === pIdx || selectedMobileGapIndex === pIdx)) && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); if (!processing) handleSplitAtParagraph(pIdx); }}
                                    disabled={processing}
                                    className="absolute z-20 flex items-center gap-1 rounded-full border border-accent bg-accent px-3 py-1 text-[10px] font-semibold text-accent-fg"
                                  ><Scissors size={11} /> 在此剪开</button>
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
          /* 阅读模式 */
          <div key={activeChapter.id} className="flex h-full flex-1 flex-col overflow-hidden view-enter">
            <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-6 py-3.5">
              <div className="min-w-0">
                <div className="eyebrow">Chapter {activeChapter.chapterIndex}</div>
                <h3 className="mt-0.5 truncate text-sm font-semibold text-fg">{activeChapter.name}</h3>
              </div>
              <div className="flex items-center gap-3">
                {activeChapter.wordCount > 12000 && (
                  <button onClick={() => setIsSplitMode(true)} disabled={processing} className="btn btn-secondary btn-sm gap-1.5"><Scissors size={13} /> 帮我裁切</button>
                )}
                <div className="shrink-0 font-mono text-xs tabular-nums text-fg-muted">{activeChapter.wordCount} 字</div>
              </div>
            </div>

            <div className="relative flex-1 select-text space-y-5 overflow-y-auto px-8 py-6">
              {activeChapter.wordCount < 120 && (
                <div className="flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-subtle p-3.5 text-xs leading-relaxed text-danger">
                  <AlertTriangle size={16} className="mt-px shrink-0" />
                  <div><span className="font-semibold">本章字数极低（只有 {activeChapter.wordCount} 字）。</span>似乎是请假条或闲聊，建议将其一键缝合至上一章。</div>
                </div>
              )}
              {activeChapter.wordCount > 12000 && (
                <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-3.5 text-xs leading-relaxed text-fg">
                  <Scissors size={16} className="mt-px shrink-0 text-fg-muted" />
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <div><span className="font-semibold">本章字数过长（含有 {activeChapter.wordCount} 字）。</span>建议先手动裁切，再继续 DNA 提取。</div>
                    <button onClick={() => setIsSplitMode(true)} disabled={processing} className="btn btn-primary btn-sm shrink-0 gap-1"><Scissors size={13} /> 帮我裁切</button>
                  </div>
                </div>
              )}
              <article className="prose-reader mx-auto max-w-2xl text-[15px] leading-[1.85]" style={{ fontFamily: 'var(--sans)' }}>{activeChapter.content}</article>
            </div>
          </div>
        )}

        {/* 模型配置卡 — 右侧滑入 */}
        <div
          className={`absolute right-0 top-0 z-30 h-full w-[380px] transition-transform duration-[400ms] ${isCrystalOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full'}`}
          style={{ transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)' }}
          aria-hidden={!isCrystalOpen}
        >
          <div className="flex h-full flex-col border-l border-line bg-canvas shadow-pop">
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-line p-5">
              <div>
                <div className="eyebrow">Model Config</div>
                <h3 className="mt-0.5 text-sm font-semibold text-fg">模型配置</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">配置云端 API Key，或确认本地 Ollama 已就绪，再执行 AI 辅助拆分。</p>
              </div>
              <button onClick={() => setIsCrystalOpen(false)} className="btn btn-ghost btn-sm btn-icon" aria-label="关闭"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <ProviderCredentialsEditor
                variant="crystal"
                providerSelector="tabs"
                collapsibleAdvanced
                apiKeyLabel="云端模型 API Key"
                keyHelpText="密钥仅以混淆形式存储于本地浏览器，绝不上传服务器。"
                ollamaSlot={
                  <div className="space-y-2 rounded-md border border-line bg-surface p-3">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${
                        ollamaStatus === 'online' ? 'bg-success'
                          : ollamaStatus === 'checking' || ollamaStatus === 'unknown' ? 'animate-pulse bg-fg-subtle motion-reduce:animate-none'
                          : 'bg-danger'
                      }`} />
                      <span className="text-xs font-medium text-fg">
                        {ollamaStatus === 'online' ? 'Ollama 已连接'
                          : ollamaStatus === 'checking' ? '正在检查 Ollama…'
                          : ollamaStatus === 'unknown' ? '待检查'
                          : 'Ollama 未就绪'}
                      </span>
                    </div>
                    {ollamaMessage && <p className="text-[11px] leading-relaxed text-fg-muted">{ollamaMessage}</p>}
                  </div>
                }
              />
            </div>
            <div className="shrink-0 border-t border-line p-4">
              <button onClick={() => void runSmartSplit()} disabled={smartSplitLoading || !crystalReady} className="btn btn-primary w-full gap-1.5">
                <Sparkles size={14} /> {smartSplitLoading ? '正在智能分析…' : '开始 AI 辅助拆分'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 撤销 / 成功 Toast */}
      {toast && toast.show && (
        <div className={`fixed bottom-6 left-1/2 z-50 flex min-w-[320px] max-w-md -translate-x-1/2 flex-col rounded-lg border p-4 text-xs shadow-pop view-enter ${
          toast.type === 'success' ? 'border-success/40 bg-surface text-success' : 'border-line bg-surface text-fg-muted'
        }`}>
          <div className="flex items-center justify-between gap-4">
            <span className={`font-medium ${toast.type === 'success' ? 'text-success' : 'text-fg'}`}>{toast.message}</span>
            {toast.type === 'stitch' && canUndo && (
              <button onClick={handleUndo} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 font-semibold text-fg transition-colors hover:bg-raised" aria-label="撤销操作"><Undo2 size={13} /> 撤销</button>
            )}
          </div>
          <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-line">
            <div className={`h-full transition-all duration-100 ease-linear ${toast.type === 'success' ? 'bg-success' : 'bg-fg-subtle'}`} style={{ width: `${(toast.countdown / 6000) * 100}%` }} />
          </div>
        </div>
      )}

      {/* 批量操作浮条 */}
      <div className={`fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-full border border-line bg-surface px-5 py-3 shadow-pop transition-all duration-300 ${
        selectedChapterIds.size >= 2 ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-20 opacity-0'
      }`}>
        <span className="text-xs font-semibold text-fg">已选中 <span className="font-mono tabular-nums">{selectedChapterIds.size}</span> 个章节</span>
        <div className="h-4 w-px bg-line" />
        <button onClick={() => setShowBulkModal(true)} className="btn btn-primary btn-sm gap-1.5" aria-label="批量合并章节"><Link2 size={13} /> 批量合并</button>
        <button onClick={() => setSelectedChapterIds(new Set())} className="btn btn-ghost btn-sm" aria-label="取消选择">取消</button>
      </div>

      {/* 批量确认弹窗 */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4">
          <div ref={bulkModalRef} className="glass pop-enter w-full max-w-[400px] space-y-4 rounded-lg p-5 shadow-pop">
            <div className="flex items-center gap-2 text-fg"><Link2 size={15} /><h3 className="text-sm font-semibold">批量物理合并确认</h3></div>
            <p className="text-xs leading-relaxed text-fg-muted">确认合并选中的 <span className="font-semibold text-fg">{selectedChapterIds.size}</span> 个章节？此操作将按目录顺序物理拼接文本，且第一章无法被并入。</p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowBulkModal(false)} className="btn btn-ghost" aria-label="取消合并">取消</button>
              <button onClick={() => { setShowBulkModal(false); handleBulkStitch(); }} className="btn btn-primary" aria-label="确认批量合并">确认合并</button>
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
