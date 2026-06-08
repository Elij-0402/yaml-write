'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ChevronLeft, Wrench, Palette, ArrowUpDown, ArrowRight, ArrowUp, Sparkles, Shuffle,
  X, Square, Copy, Download, RotateCcw, PenLine, ArrowDownToLine, Check, Wand2, Dna,
} from 'lucide-react';
import { db, isFourLayerDnaCard, type FusionSession } from '../app/db';
import { isDnaReady } from '../app/dnaState';
import { type BlockKey, type FusionDirection, type SettingBlocks, type StructureBeat, parseFusionDirections } from '../app/dnaSchema';
import { withRateLimitRetry } from '../app/dnaEngine';
import { StreamSseError, callStructured, ensureLlmConfigReady, streamSse } from '../app/llmClient';
import { useAppStore } from '../app/store';
import AppDialog from './AppDialog';

interface RepairGap { beat: string; issue: string; patch: string; }

interface FusionRecipe {
  engineCard: { novelName: string; structureSkeleton: StructureBeat[]; pacingSyuzhet: string };
  skinSource: { novelName: string; themeSkin: string; proseStyle: string; userBrief: string };
  mode: 'self' | 'cross';
  freedom: boolean;
}

type WorkshopStep = 'material' | 'directions' | 'creator' | 'manuscript';
type SceneResumeStatus = 'idle' | 'failed-resumable' | 'resuming' | 'done';

const BLOCKS: { key: BlockKey; label: string }[] = [
  { key: 'worldviewBlock', label: '世界观' },
  { key: 'protagonistBlock', label: '主角' },
  { key: 'antagonistBlock', label: '对手' },
  { key: 'narrativeTone', label: '叙事' },
];
const isBlockKey = (value: string): value is BlockKey => BLOCKS.some((block) => block.key === value);

const ANTI_SLOP_PHRASES = [
  '命运的齿轮', '那一刻', '逆天改命', '眼神变得坚定', '嘴角勾起一抹弧度',
  '仿佛整个世界都安静了', '空气仿佛凝固', '心中一紧', '缓缓睁开眼', '不知为何',
];
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 前端兜底护栏（真相源仍是后端 prompt 约束）。
const applyAntiSlopFallback = (text: string): string =>
  ANTI_SLOP_PHRASES.reduce((acc, phrase, idx) => acc.replace(new RegExp(escapeRegExp(phrase), 'g'), `[已过滤陈词滥调#${idx + 1}]`), text);

const EMPTY_BLOCKS = { worldviewBlock: '', protagonistBlock: '', antagonistBlock: '', narrativeTone: '' };
const OPENING_SCENE_NUM = 1; // 成稿为单一连续开篇，复用 sceneTexts[1] 持久化（不引入 db 形状变更）

interface FragmentDraft { original: string; rewritten: string; }

const WORKSHOP_STEPS: Array<{ id: WorkshopStep; label: string }> = [
  { id: 'material', label: '配方' },
  { id: 'directions', label: '方向' },
  { id: 'creator', label: '设定' },
  { id: 'manuscript', label: '成稿' },
];

// Studio 外壳：breadcrumb + 本地步骤条 + 单一「下一步」行 + 返回创作库。每个步骤共用此头部。
function StudioShell({
  current,
  subtitle,
  nextLabel,
  onBack,
  children,
}: {
  current: WorkshopStep;
  subtitle: string;
  nextLabel: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  const currentIdx = WORKSHOP_STEPS.findIndex((s) => s.id === current);
  return (
    <div className="flex h-full min-h-0 flex-col view-enter">
      <div className="mb-5 shrink-0 space-y-3">
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          <button onClick={onBack} className="flex items-center gap-1 hover:text-fg"><ChevronLeft size={14} /> 创作库</button>
          <span className="text-fg-subtle">/</span>
          <span className="truncate text-fg">{subtitle}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {WORKSHOP_STEPS.map((s, i) => {
            const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'todo';
            return (
              <span key={s.id} className="flex items-center gap-1.5">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                    state === 'current' ? 'border-accent bg-accent-subtle text-accent'
                      : state === 'done' ? 'border-line bg-surface text-fg-muted'
                      : 'border-line bg-surface text-fg-subtle'
                  }`}
                >
                  <span className="font-mono text-[10px]">{i + 1}</span> {s.label}
                </span>
                {i < WORKSHOP_STEPS.length - 1 && <span className="h-px w-3 bg-line" />}
              </span>
            );
          })}
        </div>

        <div className="flex items-center gap-2.5 border-l-2 border-line pl-3 text-sm">
          <span className="eyebrow shrink-0">下一步</span>
          <span className="text-fg-muted">{nextLabel}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">{children}</div>
    </div>
  );
}

export default function FusionWorkshop() {
  const { setSelectedNovelId, setWorkshopOpen, rateLimited, activeCreationId, setWorkshopBusy } = useAppStore((state) => ({
    setSelectedNovelId: state.setSelectedNovelId,
    setWorkshopOpen: state.setWorkshopOpen,
    rateLimited: state.rateLimited,
    activeCreationId: state.activeCreationId,
    setWorkshopBusy: state.setWorkshopBusy,
  }));
  const novels = useLiveQuery(() => db.novels.reverse().toArray(), []) || [];
  const readyNovels = novels.filter((novel) => isDnaReady(novel));
  const firstIncompleteNovel = novels.find((novel) => !isDnaReady(novel)) || novels[0] || null;

  const [step, setStep] = useState<WorkshopStep>('material');
  // selectedIds[0] = 骨架(引擎)，selectedIds[1] = 题材(皮)；皮可缺省（自我裂变，题材取口述）。
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customPrompt, setCustomPrompt] = useState('');
  // 生成模式开关（ephemeral，刻意不持久化进 db.fusionSessions）：false=换皮变题（默认），true=0→1 原创。
  const [freedom, setFreedom] = useState(false);
  const [colliding, setColliding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [directions, setDirections] = useState<FusionDirection[]>([]);
  const [blocks, setBlocks] = useState<SettingBlocks>(EMPTY_BLOCKS);
  const [directionTitle, setDirectionTitle] = useState('');
  const [tweakTarget, setTweakTarget] = useState<BlockKey>('worldviewBlock');
  const [command, setCommand] = useState('');
  const [tweaking, setTweaking] = useState(false);

  const [sceneTexts, setSceneTexts] = useState<Record<number, string>>({});
  const [streamingScene, setStreamingScene] = useState<number | null>(null);
  const [sceneResumeStatus, setSceneResumeStatus] = useState<Record<number, SceneResumeStatus>>({});
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [adversarialRules, setAdversarialRules] = useState('');
  const [copied, setCopied] = useState(false);

  const [repairing, setRepairing] = useState(false);
  const [repairGaps, setRepairGaps] = useState<RepairGap[]>([]);

  // 创世台共创态
  const [editingBlock, setEditingBlock] = useState<BlockKey | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // 成稿选中句轻量改写
  const [selectedFragment, setSelectedFragment] = useState<string>('');
  const [fragmentDraft, setFragmentDraft] = useState<FragmentDraft | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [pendingDirectionChoice, setPendingDirectionChoice] = useState<FusionDirection | null>(null);

  const mountedRef = useRef(true);
  const streamAbortRef = useRef<AbortController | null>(null);
  const hydratedRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 必须在 effect 体内重置为 true：React 18 严格模式（App Router dev 默认开启）会
    // setup→cleanup→setup 双调用，cleanup 先把 ref 置 false；若不在此处置回 true，
    // 重挂后 ref 永远停在 false，导致下方所有异步结果被 `if (!mountedRef.current) return` 丢弃、
    // colliding/tweaking 等忙碌标志永不复位（按钮卡在「生成中…」且无结果无报错）。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamAbortRef.current?.abort();
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setPrefersReducedMotion(mediaQuery.matches);
    sync();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', sync);
      return () => mediaQuery.removeEventListener('change', sync);
    }
    mediaQuery.addListener(sync);
    return () => mediaQuery.removeListener(sync);
  }, []);

  // 按 activeCreationId 水合 / 重置（切换创作即重水合，禁回写期覆盖）。
  useEffect(() => {
    if (!activeCreationId) { hydratedRef.current = false; return; }
    let cancelled = false;
    hydratedRef.current = false;
    void (async () => {
      const saved = await db.fusionSessions.get(activeCreationId);
      if (cancelled) return;
      if (saved) {
        setSelectedIds(saved.selectedIds || []);
        setCustomPrompt(saved.customPrompt || '');
        setAdversarialRules(saved.adversarialRules || '');
        setStep(saved.step || 'material');
        setDirections(saved.directions || []);
        setBlocks(saved.blocks || EMPTY_BLOCKS);
        setDirectionTitle(saved.directionTitle || '');
        setSceneTexts(saved.sceneTexts || {});
        setSceneResumeStatus((saved.sceneResumeStatus as Record<number, SceneResumeStatus>) || {});
      } else {
        setSelectedIds([]); setCustomPrompt(''); setAdversarialRules(''); setStep('material');
        setDirections([]); setBlocks(EMPTY_BLOCKS); setDirectionTitle('');
        setSceneTexts({}); setSceneResumeStatus({});
      }
      setEditingBlock(null); setRepairGaps([]);
      setSelectedFragment(''); setFragmentDraft(null); setTweakTarget('worldviewBlock');
      if (!cancelled) hydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [activeCreationId]);

  // 空闲落盘（流式/碰撞/补洞/微调/改写进行中跳过）；get+put 同事务保 name/createdAt。
  useEffect(() => {
    if (!hydratedRef.current || !activeCreationId) return;
    if (streamingScene !== null || colliding || tweaking || repairing || rewriting) return;
    const isEmpty = selectedIds.length === 0 && directions.length === 0 && Object.keys(sceneTexts).length === 0;
    if (isEmpty) return;
    const id = activeCreationId;
    void db.transaction('rw', db.fusionSessions, async () => {
      const prev = await db.fusionSessions.get(id);
      const session: FusionSession = {
        id,
        name: prev?.name || directionTitle || '未命名创作',
        createdAt: prev?.createdAt || Date.now(),
        selectedIds,
        customPrompt,
        adversarialRules,
        step,
        directions,
        blocks,
        directionTitle,
        sceneCount: 1,
        sceneTexts,
        sceneResumeStatus,
        updatedAt: Date.now(),
      };
      await db.fusionSessions.put(session);
    });
  }, [
    activeCreationId, step, selectedIds, customPrompt, adversarialRules, directions, blocks,
    directionTitle, sceneTexts, sceneResumeStatus,
    streamingScene, colliding, tweaking, repairing, rewriting,
  ]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (streamingScene !== null || colliding || repairing || rewriting) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [streamingScene, colliding, repairing, rewriting]);

  useEffect(() => {
    setWorkshopBusy(streamingScene !== null || colliding || tweaking || repairing || rewriting);
  }, [streamingScene, colliding, tweaking, repairing, rewriting, setWorkshopBusy]);
  useEffect(() => () => setWorkshopBusy(false), [setWorkshopBusy]);

  const guardLlm = (): boolean => {
    if (!ensureLlmConfigReady().ok) {
      window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: '换皮创作' } }));
      return false;
    }
    return true;
  };

  const engineNovel = readyNovels.find((n) => n.id === selectedIds[0]) || null;
  const skinNovel = readyNovels.find((n) => n.id === selectedIds[1]) || null;
  const modelReady = ensureLlmConfigReady().ok;
  const selectedDirectionReady = Boolean(directionTitle.trim());
  const prose = sceneTexts[OPENING_SCENE_NUM] || '';
  const resume = sceneResumeStatus[OPENING_SCENE_NUM];
  const streaming = streamingScene === OPENING_SCENE_NUM;
  const nextActionLabel =
    step === 'material'
      ? '确认骨架与题材，生成方向'
      : step === 'directions'
      ? '选择一条最像你的路线'
      : step === 'creator'
      ? '确认设定并开始写开篇'
      : streaming
      ? '等待正文生成或随时停止'
      : prose.trim()
      ? '复制、导出或回到设定继续调整'
      : '生成第一版开篇';
  const backendStatus = colliding
    ? '正在根据骨架与题材生成 3 条方向'
    : repairing
    ? '正在补齐换皮后的逻辑缺口'
    : tweaking
    ? `正在改写「${BLOCKS.find((b) => b.key === tweakTarget)?.label}」`
    : streaming
    ? '正在流式生成开篇正文'
    : rewriting
    ? '正在改写你选中的片段'
    : '当前没有后台任务';
  const sourceSummary = engineNovel
    ? `骨架《${engineNovel.name}》${skinNovel ? ` × 题材《${skinNovel.name}》` : ' × 口述题材'}`
    : '先选择一本作品作为骨架';

  const pickEngine = (id: string) => setSelectedIds((prev) => (prev[1] && prev[1] !== id ? [id, prev[1]] : [id]));
  const pickSkin = (id: string) => setSelectedIds((prev) => {
    const eng = prev[0];
    if (!eng) return prev;
    return id ? [eng, id] : [eng];
  });
  const swapRoles = () => setSelectedIds((prev) => (prev.length === 2 ? [prev[1], prev[0]] : prev));

  // 角色制配方：骨架须 4 层 DNA；皮取题材书 ③④ 或单本模式的口述。
  const buildRecipe = (): FusionRecipe | { error: string } => {
    if (!engineNovel) return { error: '请先指认一本「骨架」书。' };
    const engineDna = engineNovel.dnaCard;
    if (!isFourLayerDnaCard(engineDna)) {
      return { error: `《${engineNovel.name}》还是旧版 DNA，请在书架对它「重新提取」升级为 4 层后再作骨架。` };
    }
    const skinDna = skinNovel ? skinNovel.dnaCard : null;
    const mode: 'self' | 'cross' = skinNovel ? 'cross' : 'self';
    return {
      mode,
      freedom,
      engineCard: { novelName: engineNovel.name, structureSkeleton: engineDna.structureSkeleton, pacingSyuzhet: engineDna.pacingSyuzhet },
      skinSource: {
        novelName: skinNovel?.name ?? '',
        themeSkin: isFourLayerDnaCard(skinDna) ? skinDna.themeSkin : '',
        proseStyle: isFourLayerDnaCard(skinDna) ? skinDna.proseStyle : '',
        userBrief: mode === 'self' ? customPrompt.trim() : '',
      },
    };
  };

  // 候选池：单次生成请求（首发覆盖 / 再来一批追加共用）。avoid=已有方向，喂回后端去重。
  const requestDirections = (recipe: FusionRecipe, avoid: string[], signal: AbortSignal) =>
    withRateLimitRetry(
      () => callStructured<{ directions: FusionDirection[] }>('/api/py/generate-fusion-directions', {
        engineCard: recipe.engineCard,
        skinSource: recipe.skinSource,
        mode: recipe.mode,
        freedom: recipe.freedom,
        userCustomPrompt: recipe.mode === 'cross' ? (customPrompt.trim() || undefined) : undefined,
        adversarialRules: adversarialRules.trim() || undefined,
        avoidDirections: avoid.length ? avoid : undefined,
      }, { signal, parse: parseFusionDirections }),
      { signal }
    );

  const collide = async () => {
    if (!guardLlm() || colliding) return;
    const recipe = buildRecipe();
    if ('error' in recipe) { setError(recipe.error); return; }
    setError(null);
    setColliding(true);
    try {
      const ac = new AbortController();
      const data = await requestDirections(recipe, [], ac.signal);
      if (!mountedRef.current) return;
      setDirections(data.directions || []);
      setStep('directions');
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : '生成方向失败');
    } finally {
      if (mountedRef.current) setColliding(false);
    }
  };

  // 再来一批：在原配方上追加 3 条，把现有方向喂回后端去重，停留在方向页（候选池累积）。
  const rerollDirections = async () => {
    if (!guardLlm() || colliding) return;
    const recipe = buildRecipe();
    if ('error' in recipe) { setError(recipe.error); return; }
    setError(null);
    setColliding(true);
    try {
      const ac = new AbortController();
      const avoid = directions.slice(-20).map((d) => `${d.title}：${d.concept}`);
      const data = await requestDirections(recipe, avoid, ac.signal);
      if (!mountedRef.current) return;
      setDirections((prev) => [...prev, ...(data.directions || [])]);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : '生成方向失败');
    } finally {
      if (mountedRef.current) setColliding(false);
    }
  };

  // 扔掉候选池里的一条（纯前端 filter；directions 已随会话持久化）。
  const discardDirection = (idx: number) =>
    setDirections((prev) => prev.filter((_, i) => i !== idx));

  const applyDirection = async (direction: FusionDirection) => {
    const baseBlocks = {
      worldviewBlock: direction.worldviewBlock,
      protagonistBlock: direction.protagonistBlock,
      antagonistBlock: direction.antagonistBlock,
      narrativeTone: direction.narrativeTone,
    };
    setDirectionTitle(direction.title);
    setBlocks(baseBlocks);
    setSceneTexts({}); setSceneResumeStatus({}); setRepairGaps([]);
    setEditingBlock(null);
    setTweakTarget('worldviewBlock');
    setStep('creator');

    const recipe = buildRecipe();
    if ('error' in recipe) return;
    setError(null);
    setRepairing(true);
    try {
      const ac = new AbortController();
      const repaired = await withRateLimitRetry(
        () => callStructured<{ worldviewBlock: string; protagonistBlock: string; antagonistBlock: string; narrativeTone: string; gaps?: RepairGap[] }>('/api/py/repair-setting-gaps', {
          ...baseBlocks,
          structureSkeleton: recipe.engineCard.structureSkeleton,
          themeSkin: recipe.skinSource.themeSkin || recipe.skinSource.userBrief || '',
          adversarialRules: adversarialRules.trim() || undefined,
        }, { signal: ac.signal }),
        { signal: ac.signal }
      );
      if (!mountedRef.current) return;
      setBlocks({
        worldviewBlock: repaired.worldviewBlock || baseBlocks.worldviewBlock,
        protagonistBlock: repaired.protagonistBlock || baseBlocks.protagonistBlock,
        antagonistBlock: repaired.antagonistBlock || baseBlocks.antagonistBlock,
        narrativeTone: repaired.narrativeTone || baseBlocks.narrativeTone,
      });
      setRepairGaps(Array.isArray(repaired.gaps) ? repaired.gaps : []);
    } catch {
      /* 补洞失败：保留方向原始设定，不阻断 */
    } finally {
      if (mountedRef.current) setRepairing(false);
    }
  };

  const chooseDirection = async (direction: FusionDirection) => {
    if (Object.keys(sceneTexts).length > 0) {
      setPendingDirectionChoice(direction);
      return;
    }
    await applyDirection(direction);
  };

  // ---- 创世台：手动直接编辑 ----
  const startEdit = (key: BlockKey) => { setEditingBlock(key); setEditDraft(blocks[key]); };
  const cancelEdit = () => { setEditingBlock(null); setEditDraft(''); };
  const saveEdit = (key: BlockKey) => {
    if (editDraft === blocks[key]) { cancelEdit(); return; }
    setBlocks((prev) => ({ ...prev, [key]: editDraft }));
    cancelEdit();
  };

  // ---- 创世台：AI 指令 → 直接套用到目标卡（无 diff、无确认门）----
  const runTweak = async (rawInstruction?: string) => {
    const instruction = (rawInstruction ?? command).trim();
    if (!guardLlm() || !instruction || tweaking) return;
    setError(null);
    setEditingBlock(null);
    setTweaking(true);
    try {
      const ac = new AbortController();
      const data = await withRateLimitRetry(
        () => callStructured<Partial<Record<BlockKey, string>> & { modifiedBlocks: BlockKey[] }>('/api/py/tweak-fusion-blocks', {
          ...blocks,
          targetBlock: tweakTarget,
          userInstruction: instruction,
          adversarialRules: adversarialRules.trim() || undefined,
        }, { signal: ac.signal }),
        { signal: ac.signal }
      );
      if (!mountedRef.current) return;
      const reported = (data.modifiedBlocks || []).filter((k): k is BlockKey => isBlockKey(k));
      const newText = reported.includes(tweakTarget) && typeof data[tweakTarget] === 'string' ? (data[tweakTarget] as string) : null;
      if (newText === null || newText === blocks[tweakTarget]) {
        setError('该指令未改动当前目标卡，换个说法或先切换目标卡。');
        return;
      }
      setBlocks((prev) => ({ ...prev, [tweakTarget]: newText }));
      setCommand('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '调整失败');
    } finally {
      if (mountedRef.current) setTweaking(false);
    }
  };

  // ---- 成稿：单一连续开篇正文（复用 stream-scene-text，合成开篇 scene）----
  const selectedDirection = () => ({ title: directionTitle, ...blocks });
  const openingScene = () => ({
    sceneNumber: OPENING_SCENE_NUM,
    sceneTitle: `${directionTitle || '新作'} · 开篇`,
    plotOutline: '小说开篇：用具象的画面、动作与器物自然带出世界观、主角处境与核心钩子；不写大纲、不解释设定、不空泛抒情。',
    tensionLevel: '低开埋钩子，结尾留一个让人想读下一章的悬念',
    visualCues: '按世界观与叙事色调营造开篇画面与氛围',
  });

  const streamOpening = async (mode: 'fresh' | 'resume' = 'fresh') => {
    if (!guardLlm() || streamingScene !== null) return;
    setError(null);
    const num = OPENING_SCENE_NUM;
    const existingDraft = sceneTexts[num] || '';
    let received = mode === 'resume' ? existingDraft : '';
    setSceneResumeStatus((prev) => ({ ...prev, [num]: mode === 'resume' ? 'resuming' : 'idle' }));
    if (mode === 'fresh') setSceneTexts((prev) => ({ ...prev, [num]: '' }));
    setStreamingScene(num);
    const ac = new AbortController();
    streamAbortRef.current = ac;
    try {
      await streamSse('/api/py/stream-scene-text', {
        selectedDirection: selectedDirection(),
        currentScene: openingScene(),
        precedingTexts: {},
        currentDraft: mode === 'resume' ? existingDraft : undefined,
        adversarialRules: adversarialRules.trim() || undefined,
      }, {
        signal: ac.signal,
        onDelta: (text) => {
          const sanitized = applyAntiSlopFallback(text);
          received += sanitized;
          setSceneTexts((prev) => ({ ...prev, [num]: (prev[num] || '') + sanitized }));
        },
      });
      setSceneResumeStatus((prev) => ({ ...prev, [num]: 'done' }));
    } catch (err) {
      const aborted = ac.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      const hasText = received.trim().length > 0 || existingDraft.trim().length > 0;
      const resumable = aborted || (err instanceof StreamSseError && err.resumable) || hasText;
      if (resumable) {
        setSceneResumeStatus((prev) => ({ ...prev, [num]: 'failed-resumable' }));
        setError(aborted ? '已停止，可点「继续接写」续写。' : `中断：${message}，可继续接写。`);
      } else {
        setSceneResumeStatus((prev) => ({ ...prev, [num]: 'idle' }));
        setError(message);
      }
    } finally {
      setStreamingScene(null);
      streamAbortRef.current = null;
    }
  };

  const goManuscript = () => {
    setStep('manuscript');
    if (!(sceneTexts[OPENING_SCENE_NUM] || '').trim()) void streamOpening('fresh');
  };

  const copyManuscript = async () => {
    try {
      await navigator.clipboard.writeText(sceneTexts[OPENING_SCENE_NUM] || '');
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => { if (mountedRef.current) setCopied(false); }, 1500);
    } catch {
      setError('复制失败，请手动选择正文复制（部分浏览器需 HTTPS 或用户手势）。');
    }
  };

  const exportMd = () => {
    const title = directionTitle || '未命名创作';
    const settingLines = BLOCKS.map(({ key, label }) => `- ${label}：${blocks[key] || ''}`).join('\n');
    const prose = sceneTexts[OPENING_SCENE_NUM] || '';
    if (!prose.trim()) return;
    const md = `# ${title}\n\n## 设定\n${settingLines}\n\n---\n\n${prose}\n`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${title.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 80) || 'manuscript'}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // 选中句轻量改写：捕获选区 → AI 改写片段 → 接受/拒绝（只换选中片段，无整篇 diff）。
  const onProseSelect = () => {
    if (streamingScene !== null) return;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    const text = sel ? sel.toString().trim() : '';
    setSelectedFragment(text && (sceneTexts[OPENING_SCENE_NUM] || '').includes(text) ? text : '');
  };
  const rewriteFragment = async (style: string) => {
    if (!guardLlm() || rewriting || !selectedFragment) return;
    setError(null);
    setRewriting(true);
    const original = selectedFragment;
    try {
      let received = '';
      const ac = new AbortController();
      streamAbortRef.current = ac;
      await streamSse('/api/py/stream-scene-text', {
        selectedDirection: selectedDirection(),
        currentScene: {
          sceneNumber: OPENING_SCENE_NUM,
          sceneTitle: '选中句改写',
          plotOutline: `只改写下面引号内的这一小段，使其${style}。只输出改写后的这一段文字本身，不要加引号、不要前后文、不要解释。`,
          tensionLevel: '保持与上下文一致',
          visualCues: '保持与上下文一致',
        },
        precedingTexts: {},
        currentDraft: original,
        adversarialRules: adversarialRules.trim() || undefined,
      }, {
        signal: ac.signal,
        onDelta: (text) => { received += applyAntiSlopFallback(text); },
      });
      if (!mountedRef.current) return;
      const rewritten = received.trim();
      if (rewritten) setFragmentDraft({ original, rewritten });
    } catch (err) {
      setError(err instanceof Error ? err.message : '改写失败');
    } finally {
      if (mountedRef.current) { setRewriting(false); streamAbortRef.current = null; }
    }
  };
  const acceptFragment = () => {
    if (!fragmentDraft) return;
    setSceneTexts((prev) => ({
      ...prev,
      [OPENING_SCENE_NUM]: (prev[OPENING_SCENE_NUM] || '').replace(fragmentDraft.original, fragmentDraft.rewritten),
    }));
    setFragmentDraft(null);
    setSelectedFragment('');
  };
  const rejectFragment = () => { setFragmentDraft(null); setSelectedFragment(''); };

  const backToCreations = () => setWorkshopOpen(false);
  const errorRow = error && <p className="mt-3 text-sm text-danger">{error}</p>;
  const rateRow = rateLimited && <p className="mt-2 text-xs text-accent">云端有些拥挤，已自动放缓退避重试，请稍候…</p>;

  // ============================ 渲染 ============================
  if (readyNovels.length < 1) {
    return (
      <StudioShell current="material" subtitle="新创作" nextLabel="先完成至少一本作品的 DNA 提取" onBack={backToCreations}>
        <div className="card max-w-2xl p-8">
          <div className="eyebrow">工坊入口 · 启动条件</div>
          <h2 className="mt-2 text-lg font-semibold text-fg">先让至少一本书准备好。</h2>
          <p className="mt-2 text-sm leading-7 text-fg-muted">创作工坊吃的是已经提炼完成的 DNA。没有就绪作品时，我们不会把你扔进半残的创作页，而是明确把你送回上一段流程。</p>
          {firstIncompleteNovel && (
            <button className="btn btn-secondary mt-5 gap-1.5" onClick={() => { setWorkshopOpen(false); setSelectedNovelId(firstIncompleteNovel.id); }}>
              <ChevronLeft size={14} /> 去看《{firstIncompleteNovel.name}》的提取进度
            </button>
          )}
        </div>
      </StudioShell>
    );
  }

  // ===== 配方台 =====
  if (step === 'material') {
    const recipe = buildRecipe();
    const recipeErr = 'error' in recipe ? recipe.error : null;
    const engineDna = engineNovel && isFourLayerDnaCard(engineNovel.dnaCard) ? engineNovel.dnaCard : null;
    const skinDna = skinNovel && isFourLayerDnaCard(skinNovel.dnaCard) ? skinNovel.dnaCard : null;
    return (
      <StudioShell current="material" subtitle="配方设定" nextLabel={nextActionLabel} onBack={backToCreations}>
        <div className="mx-auto max-w-4xl space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-fg">谁当骨架，谁换皮？</h2>
            <p className="mt-1 text-sm text-fg-muted">{sourceSummary}。只需决定两件事：哪本书提供结构骨架，哪本书提供题材与风格，其余交给系统。</p>
          </div>

          {/* 生成模式 */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="eyebrow">生成模式</span>
            <div className="inline-flex rounded-md border border-line bg-panel p-0.5" role="group" aria-label="生成模式">
              {([{ v: false, label: '换皮变题' }, { v: true, label: '0→1 原创' }] as const).map((opt) => (
                <button
                  key={String(opt.v)}
                  type="button"
                  onClick={() => setFreedom(opt.v)}
                  aria-pressed={freedom === opt.v}
                  className={`rounded-[5px] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    freedom === opt.v ? 'bg-surface text-fg shadow-pop' : 'text-fg-muted hover:text-fg'
                  }`}
                >{opt.label}</button>
              ))}
            </div>
            <span className="text-xs text-fg-muted">{freedom ? 'DNA 当灵感调色板，以你的意图为主轴自由重组结构' : '保持源书结构骨架，只换题材与文风'}</span>
          </div>

          {/* 配方：骨架 × 皮 */}
          <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
            <div className="card p-5">
              <div className="eyebrow flex items-center gap-1.5"><Wrench size={12} /> 骨架（引擎）</div>
              <select
                className="input mt-2 font-semibold"
                value={selectedIds[0] || ''}
                onChange={(e) => pickEngine(e.target.value)}
              >
                <option value="" disabled>选择骨架书…</option>
                {readyNovels.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}{isFourLayerDnaCard(n.dnaCard) ? '' : '（旧版DNA）'}</option>
                ))}
              </select>
              {engineDna ? (
                <div className="mt-3 space-y-2 text-xs">
                  <div><span className="text-fg-subtle">结构骨架　</span><span className="font-mono text-fg-muted">{engineDna.structureSkeleton.map((b) => b.function).filter(Boolean).slice(0, 6).join(' → ') || '—'}</span></div>
                  <div><span className="text-fg-subtle">编排节奏　</span><span className="text-fg-muted">{engineDna.pacingSyuzhet || '—'}</span></div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-fg-subtle">{engineNovel ? '此书还是旧版 DNA，请先重新提取升级为 4 层' : '从上方选一本已就绪的书作骨架'}</p>
              )}
            </div>

            <div className="flex items-center justify-center">
              <button title="对调骨架 / 题材" onClick={swapRoles} disabled={selectedIds.length !== 2} className="btn btn-secondary btn-icon" aria-label="对调骨架与题材">
                <ArrowUpDown size={16} />
              </button>
            </div>

            <div className="card p-5">
              <div className="eyebrow flex items-center gap-1.5"><Palette size={12} /> 题材（皮）</div>
              <select
                className="input mt-2 font-semibold"
                value={selectedIds[1] || ''}
                onChange={(e) => pickSkin(e.target.value)}
                disabled={!engineNovel}
              >
                <option value="">（不选题材书，直接口述新方向）</option>
                {readyNovels.filter((n) => n.id !== selectedIds[0]).map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              {skinNovel && skinDna ? (
                <div className="mt-3 space-y-2 text-xs">
                  <div><span className="text-fg-subtle">题材皮　</span><span className="text-fg-muted">{skinDna.themeSkin || '—'}</span></div>
                  <div><span className="text-fg-subtle">文笔　　</span><span className="text-fg-muted">{skinDna.proseStyle || '—'}</span></div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-fg-subtle">不选题材书时，在下方直接说明想写成什么题材，系统会基于这本书的骨架继续生成。</p>
              )}
            </div>
          </div>

          {/* 想往哪写 */}
          <input
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={skinNovel ? '想往哪写？想避开什么套路？（可留空，留空时完全依赖两本书的 DNA）' : '描述你想要的新题材或方向（不选题材书时建议填写）'}
            className="input"
          />
          <textarea
            value={adversarialRules}
            onChange={(e) => setAdversarialRules(e.target.value)}
            rows={2}
            placeholder="反套路约束（可选）：例如 禁止王子救公主、禁止开局废柴龙傲天、对手必须有合理动机…"
            className="input"
          />

          {recipeErr && <p className="text-sm text-danger">{recipeErr}</p>}
          {errorRow}
          {rateRow}

          <div>
            <button className="btn btn-primary btn-lg gap-2" onClick={collide} disabled={colliding || !engineNovel}>
              <Sparkles size={16} /> {colliding ? '生成中…' : '生成 3 个方向'} <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </StudioShell>
    );
  }

  // ===== 候选池（方向）=====
  if (step === 'directions') {
    const idxLabel = ['i.', 'ii.', 'iii.', 'iv.', 'v.', 'vi.', 'vii.', 'viii.', 'ix.', 'x.'];
    const engName = engineNovel?.name || '骨架';
    const skinLabel = skinNovel?.name || '口述题材';
    const rerollBtn = (
      <button className="btn btn-secondary gap-1.5" onClick={() => void rerollDirections()} disabled={colliding}>
        <Shuffle size={14} /> {colliding ? '生成中…' : '再来三条'}
      </button>
    );
    return (
      <StudioShell current="directions" subtitle="方向筛选" nextLabel={nextActionLabel} onBack={backToCreations}>
        <div className="mx-auto max-w-4xl space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="eyebrow">候选池 · {directions.length} 条</div>
              <h2 className="mt-1 text-lg font-semibold text-fg">挑一条，或再来一批。</h2>
              <p className="mt-1 max-w-2xl text-sm text-fg-muted">{engName} 的结构引擎 × {skinLabel} 的题材表皮。喜欢的留着、选中其一往下走；都不对就再抽一批（系统会避开已生成过的）。</p>
            </div>
            {directions.length > 0 && rerollBtn}
          </div>

          {directions.length === 0 ? (
            <div className="card flex flex-col items-center gap-4 p-10 text-center">
              <p className="text-sm text-fg-muted">候选池空了。再抽一批新方向，或回配方台调整骨架与题材。</p>
              <div className="flex flex-wrap justify-center gap-3">
                {rerollBtn}
                <button className="btn btn-ghost gap-1.5" onClick={() => setStep('material')}><ChevronLeft size={14} /> 回配方台</button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {directions.map((dir, idx) => (
                <div
                  key={idx}
                  className="card group relative flex cursor-pointer flex-col gap-3 p-5 transition-colors hover:border-fg-subtle"
                  role="button"
                  tabIndex={0}
                  onClick={() => void chooseDirection(dir)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void chooseDirection(dir); } }}
                >
                  <button
                    type="button"
                    title="扔掉这条"
                    aria-label="扔掉这条"
                    onClick={(e) => { e.stopPropagation(); discardDirection(idx); }}
                    className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-raised hover:text-danger group-hover:opacity-100"
                  ><X size={14} /></button>
                  <span className="font-mono text-xs text-fg-subtle">{idxLabel[idx] || `${idx + 1}.`}</span>
                  <h4 className="pr-6 text-base font-semibold leading-snug text-fg">{dir.title}</h4>
                  <p className="flex-1 text-[13px] leading-relaxed text-fg-muted">{dir.concept}</p>
                  {dir.transferNote && <p className="flex items-start gap-1.5 text-xs leading-relaxed text-fg-subtle"><Dna size={12} className="mt-0.5 shrink-0" /> {dir.transferNote}</p>}
                  <div className="flex flex-wrap gap-1.5">
                    <span className="chip">{engName}</span>
                    <span className="chip">{skinLabel}</span>
                  </div>
                  <span className="flex items-center gap-1 text-xs font-medium text-accent opacity-0 transition group-hover:opacity-100">选择此方向 <ArrowRight size={12} /></span>
                </div>
              ))}
            </div>
          )}

          {errorRow}
          {rateRow}

          <div className="flex flex-wrap gap-3">
            <button className="btn btn-ghost gap-1.5" onClick={() => setStep('material')}><ChevronLeft size={14} /> 回配方台</button>
            {directions.length > 0 && rerollBtn}
          </div>
        </div>
      </StudioShell>
    );
  }

  // ===== 创世台 / 成稿 共享的配方溯源名 =====
  const recipeNow = buildRecipe();
  const eng = 'error' in recipeNow ? null : recipeNow.engineCard;
  const engSrc = eng?.novelName || engineNovel?.name || '骨架书';
  const skinSrc = skinNovel?.name || '口述题材';

  // ===== 创世台 =====
  if (step === 'creator') {
    return (
      <StudioShell current="creator" subtitle={selectedDirectionReady ? directionTitle : '设定定稿'} nextLabel={nextActionLabel} onBack={backToCreations}>
        <div className="mx-auto max-w-5xl space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-fg">定地基，想改就跟我说。</h2>
            <p className="mt-1 text-sm text-fg-muted">系统已把题材迁移与设定补全做完。确认世界观、主角、对手与叙事语气；AI 改动会直接套用到选中的设定卡，你也可以随时手改。</p>
          </div>

          {repairing && (
            <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-subtle px-3 py-2 text-xs text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
              正在补洞：核对新题材能否撑起原结构骨架，修补逻辑断裂点…
            </div>
          )}
          {!repairing && repairGaps.length > 0 && (
            <details className="rounded-lg border border-success/40 bg-surface px-3 py-2 text-xs text-success">
              <summary className="cursor-pointer select-none">已自动修补 {repairGaps.length} 处设定缺口，确保这条方向前后自洽（点开查看）</summary>
              <ul className="mt-2 space-y-1.5 text-fg-muted">
                {repairGaps.map((g, i) => (<li key={i}><b className="text-success">{g.beat}</b>：{g.issue} → {g.patch}</li>))}
              </ul>
            </details>
          )}

          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <div className="space-y-3">
              {/* 引擎来源（只读溯源） */}
              {eng && (
                <>
                  <div className="card p-4">
                    <div className="flex items-center justify-between"><span className="eyebrow">① 结构骨架</span><span className="font-mono text-[10px] text-fg-subtle">来自《{engSrc}》</span></div>
                    <div className="mt-2 font-mono text-xs leading-relaxed text-fg-muted">{eng.structureSkeleton.map((b) => b.function).filter(Boolean).join(' → ') || '—'}</div>
                  </div>
                  <div className="card p-4">
                    <div className="flex items-center justify-between"><span className="eyebrow">② 编排节奏</span><span className="font-mono text-[10px] text-fg-subtle">来自《{engSrc}》</span></div>
                    <div className="mt-2 text-sm leading-relaxed text-fg-muted">{eng.pacingSyuzhet || '—'}</div>
                  </div>
                </>
              )}

              {/* 可编辑设定卡 */}
              {BLOCKS.map(({ key, label }) => {
                const active = tweakTarget === key;
                const editing = editingBlock === key;
                return (
                  <div
                    key={key}
                    className={`card cursor-pointer p-4 transition-colors ${active ? 'border-accent' : 'hover:border-fg-subtle'}`}
                    onClick={() => { if (!editing) setTweakTarget(key); }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="eyebrow">{label}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-fg-subtle">引擎《{engSrc}》· 题材《{skinSrc}》</span>
                        {!editing && <button className="btn btn-ghost btn-sm gap-1" onClick={(e) => { e.stopPropagation(); startEdit(key); }}><PenLine size={11} /> 改</button>}
                      </div>
                    </div>
                    {editing ? (
                      <div onClick={(e) => e.stopPropagation()} className="mt-2">
                        <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} className="input" />
                        <div className="mt-2 flex items-center gap-2">
                          <span className="flex-1 font-mono text-[11px] text-fg-subtle">手动编辑</span>
                          <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>取消</button>
                          <button className="btn btn-primary btn-sm gap-1" onClick={() => saveEdit(key)}><Check size={13} /> 保存</button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg">{blocks[key] || '—'}</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* AI 共创侧栏 */}
            <aside className="card h-fit space-y-3 p-4 lg:sticky lg:top-0">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-fg"><Wand2 size={15} className="text-accent" /> 与 AI 共创</div>
              <p className="text-[11px] leading-relaxed text-fg-muted">点一张卡选中目标（当前：{BLOCKS.find((b) => b.key === tweakTarget)?.label}）。说一句大白话，AI 会直接改这张卡。</p>
              <div className="rounded-lg border border-line bg-panel p-2">
                <textarea
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={`对「${BLOCKS.find((b) => b.key === tweakTarget)?.label}」说：把主角换成女性 / 开篇更孤独 / 金手指更克制…`}
                  className="w-full resize-none bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
                  rows={3}
                />
                <div className="flex justify-end">
                  <button className="btn btn-primary btn-sm btn-icon" onClick={() => void runTweak()} disabled={tweaking || !command.trim()} title="发送指令" aria-label="发送指令">
                    {tweaking ? '…' : <ArrowUp size={15} />}
                  </button>
                </div>
              </div>
            </aside>
          </div>

          {errorRow}
          {rateRow}

          <div className="flex gap-3">
            <button className="btn btn-primary gap-1.5" onClick={goManuscript} disabled={repairing}>确认设定 · 开始写开篇 <ArrowRight size={15} /></button>
            <button className="btn btn-ghost gap-1.5" onClick={() => setStep('directions')}><ChevronLeft size={14} /> 换个方向</button>
          </div>
        </div>
      </StudioShell>
    );
  }

  // ===== 成稿 =====
  return (
    <StudioShell current="manuscript" subtitle={directionTitle || '开篇成稿'} nextLabel={nextActionLabel} onBack={backToCreations}>
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-6 lg:grid-cols-[1fr_220px]">
          {/* 正文纸 */}
          <div>
            <div className="prose-reader" style={{ fontSize: 30, lineHeight: 1.2, fontWeight: 600 }}>{directionTitle || '新作'} · 第一章</div>
            <div className="mb-6 mt-1.5 font-mono text-[11px] text-fg-subtle">骨架《{engSrc}》 × 题材《{skinSrc}》 · 自动生成</div>
            <div className="prose-reader max-w-[60ch] text-justify" onMouseUp={onProseSelect}>
              {prose ? <>{prose}{streaming && !prefersReducedMotion && <span className="caret" />}</> : (
                <span className="text-fg-subtle">{streaming ? '正在生成…' : '点右侧「生成开篇」开始。'}</span>
              )}
            </div>
          </div>

          {/* 工具栏 */}
          <div className="flex flex-col gap-2 lg:sticky lg:top-0">
            <div className="eyebrow">本篇</div>
            {streaming ? (
              <button className="btn btn-primary justify-start gap-2" onClick={() => streamAbortRef.current?.abort()}><Square size={14} /> 停止生成</button>
            ) : (
              <button className="btn btn-primary justify-start gap-2" onClick={() => void streamOpening('fresh')}>
                {prose ? <><RotateCcw size={14} /> 重写开篇</> : <><PenLine size={14} /> 生成开篇</>}
              </button>
            )}
            {!streaming && resume === 'failed-resumable' && (
              <button className="btn btn-secondary justify-start gap-2" onClick={() => void streamOpening('resume')}><ArrowDownToLine size={14} /> 继续接写</button>
            )}
            <button className="btn btn-secondary justify-start gap-2" onClick={() => void copyManuscript()} disabled={!prose.trim()}>
              {copied ? <><Check size={14} /> 已复制</> : <><Copy size={14} /> 复制</>}
            </button>
            <button className="btn btn-secondary justify-start gap-2" onClick={exportMd} disabled={!prose.trim()}><Download size={14} /> 导出 .md</button>
            <button className="btn btn-ghost justify-start gap-2" onClick={() => setStep('creator')}><ChevronLeft size={14} /> 回创世台</button>

            {fragmentDraft ? (
              <div className="mt-2 space-y-2 border-t border-line pt-3 text-xs">
                <div className="text-fg-subtle">改写预览：</div>
                <div className="text-danger line-through">{fragmentDraft.original}</div>
                <div className="text-success">{fragmentDraft.rewritten}</div>
                <div className="flex gap-2">
                  <button className="btn btn-ghost btn-sm" onClick={rejectFragment}>拒绝</button>
                  <button className="btn btn-primary btn-sm gap-1" onClick={acceptFragment}><Check size={13} /> 接受</button>
                </div>
              </div>
            ) : selectedFragment ? (
              <div className="mt-2 space-y-2 border-t border-line pt-3 text-xs text-fg-muted">
                <div>选中「{selectedFragment.length > 18 ? `${selectedFragment.slice(0, 18)}…` : selectedFragment}」让 AI：</div>
                <div className="flex flex-wrap gap-1.5">
                  {['更有画面感', '更短促', '改写'].map((s) => (
                    <button key={s} className="btn btn-secondary btn-sm" disabled={rewriting} onClick={() => void rewriteFragment(s)}>{rewriting ? '…' : s}</button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-2 border-t border-line pt-3 text-xs leading-relaxed text-fg-subtle">在左侧正文里选中一句，可让 AI 就地改写（先预览、你接受才替换）。</div>
            )}
          </div>
        </div>

        {errorRow}
        {rateRow}
      </div>

      <AppDialog
        open={Boolean(pendingDirectionChoice)}
        title="切换这条创作方向？"
        description="当前开篇正文会被清空，因为它和现有方向绑定。确认后，系统会把你带到新的设定定稿流程。"
        confirmLabel="确认切换"
        onClose={() => setPendingDirectionChoice(null)}
        onConfirm={() => {
          const direction = pendingDirectionChoice;
          setPendingDirectionChoice(null);
          if (direction) void applyDirection(direction);
        }}
      />
    </StudioShell>
  );
}
