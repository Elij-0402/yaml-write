'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
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

const WORKSHOP_STEPS: Array<{ id: WorkshopStep; label: string; kicker: string }> = [
  { id: 'material', label: '配方设定', kicker: '选择骨架与题材' },
  { id: 'directions', label: '方向筛选', kicker: '挑一条，可随时再来一批' },
  { id: 'creator', label: '设定定稿', kicker: '确认世界观与人物关系' },
  { id: 'manuscript', label: '开篇成稿', kicker: '流式生成并微调正文' },
];

function WorkshopProgress({
  current,
  nextLabel,
}: {
  current: WorkshopStep;
  nextLabel: string;
}) {
  return (
    <div className="mb-8 rounded-[12px] border border-default bg-[var(--ink-raise)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="eyebrow !mb-1">Creation Workflow · 创作后半程</div>
          <p className="text-sm leading-6 text-secondary">这里承接前面已经完成的 DNA 结果，继续完成题材选择、设定定稿和开篇生成。每一步都会明确告诉你系统在做什么、你现在要做什么。</p>
        </div>
        <div className="rounded-full border border-default bg-[color:var(--surface)] px-3 py-1 text-[11px] text-secondary">
          下一步 · <span className="text-primary">{nextLabel}</span>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {WORKSHOP_STEPS.map((step, idx) => {
          const active = step.id === current;
          const complete = WORKSHOP_STEPS.findIndex((item) => item.id === current) > idx;
          return (
            <div
              key={step.id}
              className={`min-w-[148px] rounded-2xl border px-3 py-3 text-left ${
                active
                  ? 'border-[color:var(--signal)]/40 bg-[color:var(--signal-soft)]'
                  : complete
                  ? 'border-default bg-[color:var(--surface)]'
                  : 'border-default bg-transparent'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] tracking-[0.18em] text-muted">0{idx + 1}</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    active ? 'bg-[color:var(--signal)]' : complete ? 'bg-[color:var(--ink)]' : 'bg-[color:var(--faint)]'
                  }`}
                />
              </div>
              <div className="mt-2 text-sm text-primary">{step.label}</div>
              <div className="mt-1 text-[11px] leading-5 text-secondary">{step.kicker}</div>
            </div>
          );
        })}
      </div>
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

  // ============================ 渲染 ============================
  if (readyNovels.length < 1) {
    return (
      <div className="atelier max-w-3xl">
        <WorkshopProgress current="material" nextLabel="先完成至少一本作品的 DNA 提取" />
        <div className="rounded-[12px] border border-default bg-[var(--ink-raise)] p-8">
          <div className="eyebrow">工坊入口 · 启动条件</div>
          <h2 className="atelier-h1">先让至少一本书<span className="it">准备好</span>。</h2>
          <p className="lede !mb-0">这里吃的是已经提炼完成的 DNA。没有就绪作品时，我们不会把你扔进半残的创作页，而是明确把你送回上一段流程。</p>
        </div>
        {firstIncompleteNovel && (
          <button className="cta ghost mt-6" onClick={() => { setWorkshopOpen(false); setSelectedNovelId(firstIncompleteNovel.id); }}>
            ← 去看《{firstIncompleteNovel.name}》的提取进度
          </button>
        )}
      </div>
    );
  }

  // ===== 配方台 =====
  if (step === 'material') {
    const recipe = buildRecipe();
    const recipeErr = 'error' in recipe ? recipe.error : null;
    const engineDna = engineNovel && isFourLayerDnaCard(engineNovel.dnaCard) ? engineNovel.dnaCard : null;
    const skinDna = skinNovel && isFourLayerDnaCard(skinNovel.dnaCard) ? skinNovel.dnaCard : null;
    return (
      <div className="atelier">
        <WorkshopProgress current="material" nextLabel={nextActionLabel} />
        <div className="mb-6 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[12px] border border-default bg-[color:var(--surface)] p-4">
            <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>当前素材来源</div>
            <div className="mt-2 text-sm text-primary">{sourceSummary}</div>
            <p className="mt-1 text-xs leading-6 text-secondary">先决定哪本书提供叙事引擎，哪本书提供题材和表皮。后面所有方向、设定和正文都会围绕这组输入展开。</p>
          </div>
          <div className="rounded-[12px] border p-4" style={{ borderColor: modelReady ? 'var(--signal)' : 'var(--hair)', background: modelReady ? 'var(--signal-soft)' : 'var(--surface)' }}>
            <div className="text-[11px] uppercase tracking-[0.24em]" style={{ fontFamily: 'var(--font-mono)', color: modelReady ? 'var(--signal)' : 'var(--muted)' }}>系统状态</div>
            <div className="mt-2 text-sm" style={{ color: 'var(--ink-text)' }}>{modelReady ? '模型已就绪，可直接生成方向。' : '模型还没配置，点击生成时会直接带你去设置。'}</div>
            <p className="mt-1 text-xs leading-6 text-secondary">{backendStatus}</p>
          </div>
        </div>
        <div className="eyebrow">创作配方 · 素材拼装</div>
        <h2 className="atelier-h1">谁当<span className="it">骨架</span>，谁换<span className="it">皮</span>?</h2>
        <p className="lede">这一步只需要决定两件事：哪本书提供结构骨架，哪本书提供题材与风格。没有复杂参数，其余交给系统完成。</p>

        <div className="recipe">
          <div className="slab engine">
            <div className="role">🔧 骨架</div>
            <select
              className="bk"
              style={{ background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', maxWidth: '100%' }}
              value={selectedIds[0] || ''}
              onChange={(e) => pickEngine(e.target.value)}
            >
              <option value="" disabled>选择骨架书…</option>
              {readyNovels.map((n) => (
                <option key={n.id} value={n.id}>{n.name}{isFourLayerDnaCard(n.dnaCard) ? '' : '（旧版DNA）'}</option>
              ))}
            </select>
            {engineDna ? (
              <>
                <div className="layerline"><span className="k">结构骨架</span>{engineDna.structureSkeleton.map((b) => b.function).filter(Boolean).slice(0, 6).join(' → ') || '—'}</div>
                <div className="layerline"><span className="k">编排节奏</span>{engineDna.pacingSyuzhet || '—'}</div>
              </>
            ) : (
              <div className="layerline"><span className="k">提示</span>{engineNovel ? '此书还是旧版 DNA，请先重新提取升级为 4 层' : '从上方选一本已就绪的书作骨架'}</div>
            )}
          </div>

          <div className="swap"><button title="对调骨架 / 题材" onClick={swapRoles} disabled={selectedIds.length !== 2}>⇅</button></div>

          <div className="slab skin">
            <div className="role">🎨 题材</div>
            <select
              className="bk"
              style={{ background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', maxWidth: '100%', color: 'var(--paper-text)' }}
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
              <>
                <div className="layerline"><span className="k">题材皮</span>{skinDna.themeSkin || '—'}</div>
                <div className="layerline"><span className="k">文笔</span>{skinDna.proseStyle || '—'}</div>
              </>
            ) : (
              <div className="layerline"><span className="k">口述方向</span>如果不选题材书，就在下方直接说明你想写成什么题材，系统会基于这本书的骨架继续生成。</div>
            )}
          </div>
        </div>

        <div className="wishbar">
          <input
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={skinNovel ? '想往哪写？想避开什么套路？（可留空，留空时完全依赖两本书的 DNA）' : '描述你想要的新题材或方向（不选题材书时建议填写）'}
          />
          <span className="opt">{skinNovel ? '可选' : '建议填写'}</span>
        </div>

        <div className="space-y-2">
          <textarea
            value={adversarialRules}
            onChange={(e) => setAdversarialRules(e.target.value)}
            rows={2}
            placeholder="反套路约束（可选）：例如 禁止王子救公主、禁止开局废柴龙傲天、对手必须有合理动机…"
            className="w-full rounded-[11px] border border-default bg-secondary p-3 text-sm text-secondary focus:outline-none focus:border-[color:var(--signal)]"
            style={{ fontFamily: 'var(--font-serif)' }}
          />
        </div>

        {recipeErr && <p className="mt-3 text-sm" style={{ color: 'var(--del)' }}>{recipeErr}</p>}
        {error && <p className="mt-2 text-sm" style={{ color: 'var(--del)' }}>{error}</p>}
        {rateLimited && <p className="mt-2 text-xs" style={{ color: 'var(--signal)' }}>云端有些拥挤，已自动放缓退避重试，请稍候…</p>}

        <div className="mt-6">
          <button className="cta" onClick={collide} disabled={colliding || !engineNovel}>
            {colliding ? '生成中…' : '生成 3 个方向'} <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>→</span>
          </button>
        </div>
      </div>
    );
  }

  // ===== 候选池（原三方向）=====
  if (step === 'directions') {
    const idxLabel = ['i.', 'ii.', 'iii.', 'iv.', 'v.', 'vi.', 'vii.', 'viii.', 'ix.', 'x.'];
    const engName = engineNovel?.name || '骨架';
    const skinLabel = skinNovel?.name || '口述题材';
    const rerollBtn = (
      <button className="cta ghost" onClick={() => void rerollDirections()} disabled={colliding}>
        {colliding ? '生成中…' : '🎲 再来三条'}
      </button>
    );
    return (
      <div className="atelier">
        <WorkshopProgress current="directions" nextLabel={nextActionLabel} />
        <div className="mb-6 rounded-[12px] border border-default bg-[color:var(--surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>方向上下文</div>
              <div className="mt-2 text-sm text-primary">{engName} 的结构引擎 × {skinLabel} 的题材表皮</div>
              <p className="mt-1 text-xs leading-6 text-secondary">在同一组输入上挑一条创作方向。不满意就「再来三条」往池子里追加（系统会避开已生成过的），不想要的随手扔掉。选中的那条会继续流入设定定稿与正文生成。</p>
            </div>
            <div className="rounded-full border border-default px-3 py-1 text-[11px] text-secondary">状态 · {backendStatus}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="eyebrow">创作方向 · 候选池（{directions.length}）</div>
            <h2 className="atelier-h1">挑一条，或<span className="it">再来一批</span>。</h2>
          </div>
          {directions.length > 0 && rerollBtn}
        </div>
        <p className="lede">同一套「{engName} 的结构骨架 × {skinLabel} 的题材风格」能生出无数条路线。先看这几条，喜欢的留着、选中其一往下走；都不对就再抽一批。</p>

        {directions.length === 0 ? (
          <div className="rounded-[12px] border border-default bg-[color:var(--surface)] p-8 text-center">
            <p className="text-sm text-secondary">候选池空了。再抽一批新方向，或回配方台调整骨架与题材。</p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              {rerollBtn}
              <button className="cta ghost" onClick={() => setStep('material')}>← 回配方台</button>
            </div>
          </div>
        ) : (
          <div className="dirs">
            {directions.map((dir, idx) => (
              <div
                key={idx}
                className="dir"
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
                  style={{ position: 'absolute', top: 8, right: 8, lineHeight: 1, fontSize: 13, color: 'var(--muted)', padding: 4, background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  ✕
                </button>
                <span className="idx">{idxLabel[idx] || `${idx + 1}.`}</span>
                <h4>{dir.title}</h4>
                <p className="concept">{dir.concept}</p>
                {dir.transferNote && <p className="concept" style={{ color: 'var(--ink-faint)', fontSize: 12 }}>🧬 {dir.transferNote}</p>}
                <div className="recipe-tag">
                  <span className="chip eng">{engName}</span>
                  <span className="chip skn">{skinLabel}</span>
                </div>
                <span className="pick">选择此方向 ↗</span>
              </div>
            ))}
          </div>
        )}

        {error && <p className="mt-4 text-sm" style={{ color: 'var(--del)' }}>{error}</p>}
        {rateLimited && <p className="mt-2 text-xs" style={{ color: 'var(--signal)' }}>云端有些拥挤，已自动放缓退避重试，请稍候…</p>}

        <div className="mt-7 flex flex-wrap gap-3">
          <button className="cta ghost" onClick={() => setStep('material')}>← 回配方台</button>
          {directions.length > 0 && rerollBtn}
        </div>
      </div>
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
      <div className="atelier">
        <WorkshopProgress current="creator" nextLabel={nextActionLabel} />
        <div className="mb-6 grid gap-3 lg:grid-cols-3">
          <div className="rounded-[12px] border border-default bg-[color:var(--surface)] p-4">
            <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>当前方向</div>
            <div className="mt-2 text-sm text-primary">{selectedDirectionReady ? directionTitle : '还未确认方向'}</div>
            <p className="mt-1 text-xs leading-6 text-secondary">这里展示的是已经把骨架和题材嫁接后的新书地基，不是素材摘抄。</p>
          </div>
          <div className="rounded-[12px] border border-default bg-[color:var(--surface)] p-4">
            <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>AI 状态</div>
            <div className="mt-2 text-sm text-primary">{backendStatus}</div>
            <p className="mt-1 text-xs leading-6 text-secondary">AI 修改会直接套用到选中的设定卡；你也可以随时 ✎ 手改或继续追加指令。</p>
          </div>
          <div className="rounded-[12px] border border-default bg-[color:var(--surface)] p-4">
            <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>下一决策</div>
            <div className="mt-2 text-sm text-primary">确认设定并写开篇</div>
            <p className="mt-1 text-xs leading-6 text-secondary">把世界观、人物关系和叙事语气捋顺后，就可以进入流式成稿，不需要再跳去别的页面找入口。</p>
          </div>
        </div>
        <div className="eyebrow">设定定稿 · 创作中枢</div>
        <h2 className="atelier-h1">定<span className="it">地基</span>。想改就跟我说。</h2>
        <p className="lede">系统已经把题材迁移和设定补全做完了。这里是你确认世界观、主角、对手和叙事语气的地方；AI 改动会直接套用到选中的设定卡，你也可以随时手改。</p>

        {repairing && (
          <div className="mb-4 flex items-center gap-2 rounded-[9px] border px-3 py-2 text-xs" style={{ borderColor: 'var(--signal)', background: 'var(--signal-soft)', color: 'var(--signal)' }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: 'var(--signal)' }} />
            正在补洞：核对新题材能否撑起原结构骨架，修补逻辑断裂点…
          </div>
        )}
        {!repairing && repairGaps.length > 0 && (
          <details className="mb-4 rounded-[9px] border px-3 py-2 text-xs" style={{ borderColor: 'var(--add)', background: 'var(--add-soft)', color: 'var(--add)' }}>
            <summary className="cursor-pointer select-none">🩹 已自动修补 {repairGaps.length} 处设定缺口，确保这条方向前后自洽（点开查看）</summary>
            <ul className="mt-2 space-y-1.5" style={{ color: 'var(--ink-dim)' }}>
              {repairGaps.map((g, i) => (<li key={i}><b style={{ color: 'var(--add)' }}>{g.beat}</b>：{g.issue} → {g.patch}</li>))}
            </ul>
          </details>
        )}

        <div className="studio">
          <div className="setcards">
            {/* 引擎来源（只读溯源）：迁移不变量 */}
            {eng && (
              <>
                <div className="setcard eng">
                  <div className="lab"><span className="l">① 结构骨架</span><span className="src">来自《{engSrc}》</span></div>
                  <div className="body">{eng.structureSkeleton.map((b) => b.function).filter(Boolean).join(' → ') || '—'}</div>
                </div>
                <div className="setcard eng">
                  <div className="lab"><span className="l">② 编排节奏</span><span className="src">来自《{engSrc}》</span></div>
                  <div className="body">{eng.pacingSyuzhet || '—'}</div>
                </div>
              </>
            )}

            {/* 换皮后的具体新书设定（可编辑、走 diff）；溯源标呈现引擎/皮二元 */}
            {BLOCKS.map(({ key, label }) => {
              const active = tweakTarget === key;
              const editing = editingBlock === key;
              return (
                <div
                  key={key}
                  className="setcard skn"
                  style={active ? { borderColor: 'var(--ink)' } : undefined}
                  onClick={() => { if (!editing) setTweakTarget(key); }}
                >
                  <div className="lab">
                    <span className="l">{label}</span>
                    <span className="src">引擎《{engSrc}》· 题材《{skinSrc}》</span>
                    {!editing && <button className="editbtn" onClick={(e) => { e.stopPropagation(); startEdit(key); }}>✎ 改</button>}
                  </div>
                  {editing ? (
                    <div onClick={(e) => e.stopPropagation()}>
                      <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} />
                      <div className="diffbar"><span className="why">手动编辑</span>
                        <button className="mini" onClick={cancelEdit}>取消</button>
                        <button className="mini accept" onClick={() => saveEdit(key)}>保存</button>
                      </div>
                    </div>
                  ) : (
                    <div className="body">{blocks[key] || '—'}</div>
                  )}
                </div>
              );
            })}
          </div>

          <aside className="copilot">
            <h5>与 AI 共创</h5>
            <div className="sub">点一张卡选中目标（当前：{BLOCKS.find((b) => b.key === tweakTarget)?.label}）。说一句大白话，AI 会直接改这张卡。</div>
            <div className="aibox">
              <textarea
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={`对「${BLOCKS.find((b) => b.key === tweakTarget)?.label}」说：把主角换成女性 / 开篇更孤独 / 金手指更克制…`}
              />
              <div className="ar">
                <button className="send" onClick={() => void runTweak()} disabled={tweaking || !command.trim()} title="发送指令">{tweaking ? '…' : '↑'}</button>
              </div>
            </div>
          </aside>
        </div>

        {error && <p className="mt-4 text-sm" style={{ color: 'var(--del)' }}>{error}</p>}
        {rateLimited && <p className="mt-2 text-xs" style={{ color: 'var(--signal)' }}>云端有些拥挤，已自动退避重试，请稍候…</p>}

        <div className="mt-7 flex gap-3">
          <button className="cta" onClick={goManuscript} disabled={repairing}>确认设定 · 开始写开篇 →</button>
          <button className="cta ghost" onClick={() => setStep('directions')}>← 换个方向</button>
        </div>
      </div>
    );
  }

  // ===== 成稿 =====
  return (
    <div className="atelier">
      <WorkshopProgress current="manuscript" nextLabel={nextActionLabel} />
      <div className="mb-6 grid gap-3 lg:grid-cols-3">
        <div className="rounded-[12px] border border-default bg-[color:var(--surface)] p-4">
          <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>Generation State</div>
          <div className="mt-2 text-sm text-primary">{backendStatus}</div>
          <p className="mt-1 text-xs leading-6 text-secondary">{streaming ? '正文正在一段一段落下，你可以随时停止，不会丢失当前已生成内容。' : '当前正文已保存在本地创作会话里，可以继续写、复制或导出。'} </p>
        </div>
        <div className="rounded-[12px] border border-default bg-[color:var(--surface)] p-4">
          <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>Source Recipe</div>
          <div className="mt-2 text-sm text-primary">骨架《{engSrc}》 × 题材《{skinSrc}》</div>
          <p className="mt-1 text-xs leading-6 text-secondary">这让正文来源可追溯，也让用户知道现在看到的文稿为什么会呈现这种结构与气质。</p>
        </div>
        <div className="rounded-[12px] border border-default bg-[color:var(--surface)] p-4">
          <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>Editing Contract</div>
          <div className="mt-2 text-sm text-primary">{fragmentDraft ? '正在预览片段改写' : '可选句微调，先预览再替换'}</div>
          <p className="mt-1 text-xs leading-6 text-secondary">不论是整篇重写还是片段改写，都遵守“先看结果，再决定落不落”的规则，减少失控感。</p>
        </div>
      </div>
      <div className="eyebrow">Manuscript · 开篇正文</div>
      <h2 className="atelier-h1">墨，正落在<span className="it">纸</span>上。</h2>
      <p className="lede">这里会流式生成这部作品的开篇正文。选中任意一句，都可以让 AI 就地改写；改动同样先预览、再决定是否替换。</p>

      <div className="manuscript">
        <div className="sheet">
          <div className="stamp">稿</div>
          <div className="m-title">{directionTitle || '新作'} · 第一章</div>
          <div className="by">骨架《{engSrc}》 × 题材《{skinSrc}》 · 自动生成</div>
          <div className="prose" onMouseUp={onProseSelect}>
            {prose ? <>{prose}{streaming && !prefersReducedMotion && <span className="caret" />}</> : (
              <span style={{ color: 'var(--paper-dim)' }}>{streaming ? '墨正落下…' : '点右侧「生成开篇」开始。'}</span>
            )}
          </div>
        </div>

        <div className="tools">
          <div className="th">本篇</div>
          {streaming ? (
            <button className="tool primary" onClick={() => streamAbortRef.current?.abort()}><b>■ 停止生成</b></button>
          ) : (
            <button className="tool primary" onClick={() => void streamOpening('fresh')}><b>{prose ? '↻ 重写开篇' : '✍ 生成开篇'}</b></button>
          )}
          {!streaming && resume === 'failed-resumable' && (
            <button className="tool" onClick={() => void streamOpening('resume')}><b>↧ 继续接写</b></button>
          )}
          <button className="tool" onClick={() => void copyManuscript()} disabled={!prose.trim()}><b>{copied ? '✓ 已复制' : '⎘ 复制'}</b></button>
          <button className="tool" onClick={exportMd} disabled={!prose.trim()}><b>⤓ 导出 .md</b></button>
          <button className="tool" onClick={() => setStep('creator')}><b>← 回创世台</b></button>

          {fragmentDraft ? (
            <div className="selnote" style={{ color: 'var(--ink-dim)' }}>
              改写预览：<br /><span style={{ color: 'var(--del)' }}>{fragmentDraft.original}</span><br />→ <span style={{ color: 'var(--add)' }}>{fragmentDraft.rewritten}</span>
              <div className="mt-2 flex gap-2">
                <button className="mini" onClick={rejectFragment}>拒绝</button>
                <button className="mini accept" onClick={acceptFragment}>接受</button>
              </div>
            </div>
          ) : selectedFragment ? (
            <div className="selnote">
              选中「{selectedFragment.length > 18 ? `${selectedFragment.slice(0, 18)}…` : selectedFragment}」<br />让 AI：
              <div className="mt-2 flex flex-wrap gap-1.5">
                {['更有画面感', '更短促', '改写'].map((s) => (
                  <button key={s} className="mini" disabled={rewriting} onClick={() => void rewriteFragment(s)}>{rewriting ? '…' : s}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="selnote">在左侧正文里选中一句，可让 AI 就地改写（先预览、你接受才替换）。</div>
          )}
        </div>
      </div>

      {error && <p className="mt-4 text-sm" style={{ color: 'var(--del)' }}>{error}</p>}
      {rateLimited && <p className="mt-2 text-xs" style={{ color: 'var(--signal)' }}>云端有些拥挤，已自动退避重试，请稍候…</p>}

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
    </div>
  );
}
