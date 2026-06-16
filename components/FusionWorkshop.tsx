'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ChevronLeft, Palette, ArrowUpDown, ArrowRight, ArrowUp, Sparkles, Shuffle,
  X, Square, Copy, Download, RotateCcw, PenLine, ArrowDownToLine, Check, Wand2, Dna,
  Lock, ThumbsDown, GitBranch,
} from 'lucide-react';
import { db, isFourLayerDnaCard, type FusionSession, type OpeningDraft } from '../app/db';
import { isDnaReady } from '../app/dnaState';
import { formatWordCount } from '../app/util';
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

// 开篇历史版本时间戳（mm-dd HH:MM）。app 代码可用 Date，与 Workflow 脚本的限制无关。
const fmtDraftTime = (ts: number): string => {
  const d = new Date(ts);
  return `${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')} ${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
};

// 成稿文风寄存器预设（值与后端 TONE_GUIDE 的 key 对齐）。
const TONE_PRESETS: { value: string; label: string }[] = [
  { value: '', label: '默认（贴题材）' },
  { value: 'cold', label: '冷峻克制' },
  { value: 'hot', label: '热血爽快' },
  { value: 'humor', label: '幽默轻快' },
  { value: 'lyrical', label: '抒情细腻' },
];

// 配方对话框子屏（goal·第四步信息架构）：骨架 → 题材 → 意图 → 确认。
const RECIPE_STAGES: { label: string; hint: string }[] = [
  { label: '骨架', hint: '选一本书作骨架' },
  { label: '题材', hint: '选题材书或口述' },
  { label: '意图', hint: '填写偏好（可跳过）' },
  { label: '确认', hint: '确认配方，生成方向' },
];

// Studio 外壳：顶部步进轨（数字格 1-4，当前 = 靛蓝实心 = 聚焦标记）+ 单一「下一步」提示。
// 面包屑与返回创作库由全局顶栏负责。每个步骤共用此头部。
function StudioShell({
  current,
  nextLabel,
  children,
  overlay,
}: {
  current: WorkshopStep;
  nextLabel: string;
  children: React.ReactNode;
  overlay?: React.ReactNode;
}) {
  const currentIdx = WORKSHOP_STEPS.findIndex((s) => s.id === current);
  return (
    <div className="flex h-full min-h-0 flex-col view-enter">
      <div className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center" aria-label="创作步骤">
          {WORKSHOP_STEPS.map((s, i) => {
            const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'todo';
            return (
              <span key={s.id} className="flex items-center">
                <span
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={`flex items-center gap-1.5 text-[12.5px] font-medium ${
                    state === 'current' ? 'text-fg' : state === 'done' ? 'text-fg-muted' : 'text-fg-subtle'
                  }`}
                >
                  <span
                    className={`grid h-[18px] w-[18px] place-items-center rounded-[5px] border font-mono text-[10px] leading-none ${
                      state === 'current'
                        ? 'border-accent bg-accent text-accent-fg'
                        : state === 'done'
                        ? 'border-line bg-surface text-fg-muted'
                        : 'border-line text-fg-subtle'
                    }`}
                  >
                    {state === 'done' ? <Check size={10} /> : i + 1}
                  </span>
                  {s.label}
                </span>
                {i < WORKSHOP_STEPS.length - 1 && <span className="mx-2.5 h-px w-5 bg-line" />}
              </span>
            );
          })}
        </div>
        <span className="min-w-0 truncate text-xs text-fg-subtle">下一步 · {nextLabel}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">{children}</div>
      {overlay}
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
  // 生成模式开关：false=换皮变题（默认），true=0→1 原创。v13 起按创作持久化（重载不再回默认）。
  const [freedom, setFreedom] = useState(false);
  // 成稿文风寄存器（v13 持久化）：''=贴题材默认 / cold / hot / humor / lyrical。
  const [tone, setTone] = useState('');
  // 配方对话框（goal）：当前子屏 0 骨架 / 1 题材 / 2 意图 / 3 确认。按创作持久化（v15），关闭/刷新可恢复。
  const [recipeStage, setRecipeStage] = useState(0);
  // 候选池（goal）：锁定的亮点（注入后续生成的 userCustomPrompt）+ 已弃/不喜欢方向（回喂后端 avoidDirections 去重）。
  const [lockedFeatures, setLockedFeatures] = useState<string[]>([]);
  const [avoidList, setAvoidList] = useState<string[]>([]);
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
  // 开篇历史版本（重写前归档）+ 当前正在对比的历史版索引（null=不对比）。
  const [openingDrafts, setOpeningDrafts] = useState<OpeningDraft[]>([]);
  const [comparingDraftIdx, setComparingDraftIdx] = useState<number | null>(null);
  const [nextIntent, setNextIntent] = useState(''); // 「写下一段」的可选一行意图（有界续写，不持久化）
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
        setOpeningDrafts(saved.openingDrafts || []);
        setFreedom(saved.freedom ?? false);
        setTone(saved.tone || '');
        setRecipeStage(typeof saved.recipeStage === 'number' ? saved.recipeStage : 0);
        setLockedFeatures(saved.lockedFeatures || []);
        setAvoidList(saved.avoidDirections || []);
      } else {
        setSelectedIds([]); setCustomPrompt(''); setAdversarialRules(''); setStep('material');
        setDirections([]); setBlocks(EMPTY_BLOCKS); setDirectionTitle('');
        setSceneTexts({}); setSceneResumeStatus({}); setOpeningDrafts([]);
        setFreedom(false); setTone('');
        setRecipeStage(0); setLockedFeatures([]); setAvoidList([]);
      }
      setEditingBlock(null); setRepairGaps([]); setComparingDraftIdx(null);
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
        sceneCount: Math.max(1, Object.keys(sceneTexts).filter((k) => (sceneTexts[Number(k)] || '').trim()).length),
        sceneTexts,
        sceneResumeStatus,
        openingDrafts,
        freedom,
        tone,
        recipeStage,
        avoidDirections: avoidList,
        lockedFeatures,
        updatedAt: Date.now(),
      };
      await db.fusionSessions.put(session);
    });
  }, [
    activeCreationId, step, selectedIds, customPrompt, adversarialRules, directions, blocks,
    directionTitle, sceneTexts, sceneResumeStatus, openingDrafts, freedom, tone,
    recipeStage, avoidList, lockedFeatures,
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
  // 多场景（开篇之后的有界续写）：已落正文（或正在流式）的场景号升序。开篇=1，续写=2.. 。
  const sceneNums = Object.keys(sceneTexts)
    .map(Number)
    .filter((n) => Number.isFinite(n) && ((sceneTexts[n] || '').trim().length > 0 || n === streamingScene))
    .sort((a, b) => a - b);
  const continuationNums = sceneNums.filter((n) => n !== OPENING_SCENE_NUM);
  const lastSceneNum = sceneNums.length ? sceneNums[sceneNums.length - 1] : OPENING_SCENE_NUM;
  const allProse = sceneNums.map((n) => sceneTexts[n] || '').filter((t) => t.trim()).join('\n\n');
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

  // 候选池去重上限：后端 avoidDirections 上限 40 条；本地同步裁剪保留最近的。
  const dedupCap = (arr: string[]): string[] => Array.from(new Set(arr)).slice(-40);
  const poolDescriptors = (): string[] => directions.map((d) => `${d.title}：${d.concept}`);
  // 喂回后端去重的 avoid 集合：已弃/不喜欢（avoidList）+ 当前池内方向；做变体时排除被参照那条。
  const buildAvoid = (excludeDesc?: string): string[] =>
    dedupCap([...avoidList, ...poolDescriptors()].filter((d) => d !== excludeDesc));

  // 候选池：单次生成请求（首发 / 再来一批 / 变体共用）。
  // userCustomPrompt 融合：交叉模式的口述偏好 + 锁定亮点（必须保留）+ 变体参照（保留内核换展开）。
  const requestDirections = (
    recipe: FusionRecipe,
    opts: { avoid: string[]; variantOf?: FusionDirection },
    signal: AbortSignal,
  ) => {
    const parts: string[] = [];
    if (recipe.mode === 'cross' && customPrompt.trim()) parts.push(customPrompt.trim());
    if (lockedFeatures.length) parts.push(`必须保留以下亮点（不可丢弃）：${lockedFeatures.join('；')}`);
    if (opts.variantOf) parts.push(`在这条方向的基础上做变体，保留它的内核、但换一种展开方式：「${opts.variantOf.title}——${opts.variantOf.concept}」`);
    const userCustomPrompt = parts.join('\n').trim().slice(0, 2000) || undefined;
    return withRateLimitRetry(
      () => callStructured<{ directions: FusionDirection[] }>('/api/py/generate-fusion-directions', {
        engineCard: recipe.engineCard,
        skinSource: recipe.skinSource,
        mode: recipe.mode,
        freedom: recipe.freedom,
        userCustomPrompt,
        adversarialRules: adversarialRules.trim() || undefined,
        avoidDirections: opts.avoid.length ? opts.avoid : undefined,
      }, { signal, parse: parseFusionDirections }),
      { signal }
    );
  };

  // 候选池单次请求 → 落库。'fresh'=覆盖并进方向页；'append'=追加（再来一批 / 变体）。
  // variantOf：基于某条做变体，保留内核换展开，并把那条排除出 avoid。
  const runDirections = async (kind: 'fresh' | 'append', variantOf?: FusionDirection) => {
    if (!guardLlm() || colliding) return;
    const recipe = buildRecipe();
    if ('error' in recipe) { setError(recipe.error); return; }
    setError(null);
    setColliding(true);
    try {
      const ac = new AbortController();
      const exclude = variantOf ? `${variantOf.title}：${variantOf.concept}` : undefined;
      const data = await requestDirections(recipe, { avoid: buildAvoid(exclude), variantOf }, ac.signal);
      if (!mountedRef.current) return;
      const next = data.directions || [];
      if (kind === 'fresh') { setDirections(next); setStep('directions'); }
      else setDirections((prev) => [...prev, ...next]);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : '生成方向失败');
    } finally {
      if (mountedRef.current) setColliding(false);
    }
  };
  const collide = () => runDirections('fresh');
  const rerollDirections = () => runDirections('append');
  const variantFromDirection = (direction: FusionDirection) => runDirections('append', direction);

  // 锁定某个亮点：注入后续生成（必须保留）。最多 6 条，去重。
  const lockFeature = (raw: string) => {
    const text = (raw || '').trim();
    if (!text) return;
    setLockedFeatures((prev) => (prev.includes(text) ? prev : [...prev, text].slice(-6)));
  };
  const unlockFeature = (idx: number) => setLockedFeatures((prev) => prev.filter((_, i) => i !== idx));

  // 扔掉候选池里的一条：从池中移除，并把描述记入 avoid（再来一批时避开重复，AC）。
  const discardDirection = (idx: number) => {
    const d = directions[idx];
    if (d) setAvoidList((prev) => dedupCap([...prev, `${d.title}：${d.concept}`]));
    setDirections((prev) => prev.filter((_, i) => i !== idx));
  };

  // 标记不喜欢：移除 + 把「这一类」记入 avoid（比单纯丢弃更强的避开信号，依据行也会展示）。
  const dislikeDirection = (idx: number) => {
    const d = directions[idx];
    if (d) setAvoidList((prev) => dedupCap([...prev, `不喜欢这一类：${d.title}`]));
    setDirections((prev) => prev.filter((_, i) => i !== idx));
  };

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
          freedom: recipe.freedom,
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
    if (mode === 'fresh') {
      // 重写前把当前开篇归档进历史版本（最多保留最近 5 版），可对比 / 恢复。
      if (existingDraft.trim()) {
        setOpeningDrafts((prev) => [{ text: existingDraft, createdAt: Date.now() }, ...prev].slice(0, 5));
      }
      setComparingDraftIdx(null);
      setSceneTexts((prev) => ({ ...prev, [num]: '' }));
    }
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
        tone: tone || undefined,
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
      await navigator.clipboard.writeText(allProse);
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
    if (!allProse.trim()) return;
    const md = `# ${title}\n\n## 设定\n${settingLines}\n\n---\n\n${allProse}\n`;
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
      [OPENING_SCENE_NUM]: (prev[OPENING_SCENE_NUM] || '').replace(fragmentDraft.original, () => fragmentDraft.rewritten),
    }));
    setFragmentDraft(null);
    setSelectedFragment('');
  };
  const rejectFragment = () => { setFragmentDraft(null); setSelectedFragment(''); };

  // 恢复某历史版为当前开篇：当前正文（若非空）先存回历史，再把选中版设为当前；该版从历史移除（即「当前」总不在列表里）。
  const restoreOpeningDraft = (idx: number) => {
    const draft = openingDrafts[idx];
    if (!draft || streamingScene !== null) return;
    const current = sceneTexts[OPENING_SCENE_NUM] || '';
    setOpeningDrafts((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (current.trim()) next.unshift({ text: current, createdAt: Date.now() });
      return next.slice(0, 5);
    });
    setSceneTexts((prev) => ({ ...prev, [OPENING_SCENE_NUM]: draft.text }));
    setComparingDraftIdx(null);
  };

  // ---- 开篇之后的有界续写（丁）：逐次手动写下一段。复用 stream-scene-text + precedingTexts
  // （后端按 24k 尾部截断上下文，天然有界）。硬边界＝禁自动章节循环 / 整本编排 / 大纲生成 / 一键写到结局；
  // 每段都是一次刻意的用户点击，保持「起书副驾」而非整本工厂。----
  const streamSceneAt = async (num: number, intent: string) => {
    if (!guardLlm() || streamingScene !== null) return;
    const preceding: Record<number, string> = {};
    sceneNums.filter((n) => n < num).forEach((n) => { preceding[n] = sceneTexts[n]; });
    setError(null);
    setSceneTexts((prev) => ({ ...prev, [num]: '' }));
    setSceneResumeStatus((prev) => ({ ...prev, [num]: 'idle' }));
    setStreamingScene(num);
    const ac = new AbortController();
    streamAbortRef.current = ac;
    try {
      await streamSse('/api/py/stream-scene-text', {
        selectedDirection: selectedDirection(),
        currentScene: {
          sceneNumber: num,
          sceneTitle: `第 ${num} 段`,
          plotOutline: intent.trim()
            ? `承接前文，自然往下写：${intent.trim()}。不要重述前文、不写大纲、不解释设定。`
            : '承接前文，自然往下写一个连续的场景：推进当前情节、维持设定与语气，结尾留一个让人想继续读的小钩子。不要重述前文、不写大纲、不解释设定。',
          tensionLevel: '承接前文张力，自然推进',
          visualCues: '与前文世界观与叙事色调保持一致',
        },
        precedingTexts: preceding,
        adversarialRules: adversarialRules.trim() || undefined,
        tone: tone || undefined,
      }, {
        signal: ac.signal,
        onDelta: (text) => {
          const sanitized = applyAntiSlopFallback(text);
          setSceneTexts((prev) => ({ ...prev, [num]: (prev[num] || '') + sanitized }));
        },
      });
      setSceneResumeStatus((prev) => ({ ...prev, [num]: 'done' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(ac.signal.aborted ? '已停止。' : `续写中断：${message}`);
    } finally {
      setStreamingScene(null);
      streamAbortRef.current = null;
    }
  };
  const writeNextScene = () => {
    if (!prose.trim() || streamingScene !== null) return; // 必须先有开篇才能续写
    void streamSceneAt(lastSceneNum + 1, nextIntent);
    setNextIntent('');
  };
  const rewriteLastScene = () => { if (lastSceneNum !== OPENING_SCENE_NUM) void streamSceneAt(lastSceneNum, ''); };
  const deleteLastScene = () => {
    if (lastSceneNum === OPENING_SCENE_NUM || streamingScene !== null) return; // 开篇用「重写开篇」，不在此删
    setSceneTexts((prev) => { const next = { ...prev }; delete next[lastSceneNum]; return next; });
    setSceneResumeStatus((prev) => { const next = { ...prev }; delete next[lastSceneNum]; return next; });
  };

  const errorRow = error && <p className="mt-3 text-[13px] text-danger">{error}</p>;
  const rateRow = rateLimited && <p className="mt-2 text-xs text-accent-ink">云端有些拥挤，已自动放缓退避重试，请稍候…</p>;

  // 切换方向确认弹窗：定义一次，作为 overlay 挂到方向页 StudioShell（chooseDirection 唯一触发处）。
  // 此前只渲染在成稿页 return，而 pendingDirectionChoice 只可能从方向页置真 → 方向页点切换静默无弹窗（已修）。
  const directionSwitchDialog = (
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
  );

  // ============================ 渲染 ============================
  if (readyNovels.length < 1) {
    return (
      <StudioShell current="material" nextLabel="先完成至少一本作品的 DNA 提取">
        <div className="card max-w-xl p-6">
          <div className="eyebrow">工坊入口 · 启动条件</div>
          <h2 className="mt-2 text-base font-semibold text-fg">先让至少一本书准备好。</h2>
          <p className="mt-2 text-[13px] leading-7 text-fg-muted">创作工坊吃的是已经提炼完成的 DNA。没有就绪作品时，我们不会把你扔进半残的创作页，而是明确把你送回上一段流程。</p>
          {firstIncompleteNovel && (
            <button className="btn btn-secondary mt-5 gap-1.5" onClick={() => { setWorkshopOpen(false); setSelectedNovelId(firstIncompleteNovel.id); }}>
              <ChevronLeft size={14} /> 去看《{firstIncompleteNovel.name}》的提取进度
            </button>
          )}
        </div>
      </StudioShell>
    );
  }

  // ===== 配方台 · 配方对话框（4 屏向导：骨架 → 题材 → 意图 → 确认）=====
  // 左侧「对话 / 步骤流」+ 右侧「当前选择摘要」。选择即时回执、可返回修改、子屏与选择均按创作持久化。
  if (step === 'material') {
    const recipe = buildRecipe();
    const recipeErr = 'error' in recipe ? recipe.error : null;
    const stage = Math.max(0, Math.min(RECIPE_STAGES.length - 1, recipeStage));
    const canVisit = (s: number) => s === 0 || Boolean(engineNovel); // 骨架屏永远可达，其余屏需先定骨架
    const goStage = (s: number) => { if (canVisit(s)) { setError(null); setRecipeStage(s); } };
    const novelMeta = (n: typeof readyNovels[number]) => {
      const dna = isFourLayerDnaCard(n.dnaCard) ? n.dnaCard : null;
      return {
        dna,
        beats: dna ? dna.structureSkeleton.map((b) => b.function).filter(Boolean).slice(0, 5).join(' → ') : '',
        chapters: n.splitMeta?.chapterCount,
      };
    };

    // 助理对话回执（已确认步骤）：营造连续对话感，每完成一个选择就给一句即时反馈。
    const transcript: string[] = [];
    if (stage >= 1 && engineNovel) transcript.push(`已把《${engineNovel.name}》设为骨架——它决定故事推进的力学。`);
    if (stage >= 2) transcript.push(skinNovel ? `题材来自《${skinNovel.name}》——会抽取它的世界观与文风颗粒。` : '这一轮不绑题材书，用你的一句话口述来定题材。');
    if (stage >= 3) transcript.push((customPrompt.trim() || adversarialRules.trim()) ? '偏好已记下，生成时一并考虑。' : '你没有填写偏好——本轮完全依赖两本书的 DNA 自动碰撞。');

    const assistant = (node: React.ReactNode) => (
      <div className="flex items-start gap-2">
        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <p className="text-[13px] leading-relaxed text-fg">{node}</p>
      </div>
    );
    const summaryItem = (label: string, value: string, sub?: string) => (
      <div>
        <div className="text-[11px] text-fg-subtle">{label}</div>
        <div className="mt-0.5 break-words text-[13px] text-fg">{value}</div>
        {sub && <div className="mt-0.5 text-[11px] text-fg-subtle">{sub}</div>}
      </div>
    );

    return (
      <StudioShell current="material" nextLabel={RECIPE_STAGES[stage].hint}>
        <div className="mx-auto grid w-full max-w-5xl gap-5 lg:grid-cols-[1fr_300px]">
          {/* 左：对话 / 步骤流 */}
          <div className="min-w-0 space-y-4">
            {/* 子步进（可点返回；当前=靛蓝实心格） */}
            <div className="flex flex-wrap items-center gap-y-1">
              {RECIPE_STAGES.map((s, i) => (
                <span key={s.label} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => goStage(i)}
                    disabled={!canVisit(i)}
                    aria-current={i === stage ? 'step' : undefined}
                    className={`flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      i === stage ? 'text-fg' : i < stage ? 'text-fg-muted hover:text-fg' : 'text-fg-subtle'
                    }`}
                  >
                    <span className={`grid h-[16px] w-[16px] place-items-center rounded-[4px] border font-mono text-[9px] leading-none ${
                      i === stage ? 'border-accent bg-accent text-accent-fg' : i < stage ? 'border-line bg-surface text-fg-muted' : 'border-line text-fg-subtle'
                    }`}>{i < stage ? <Check size={9} /> : i + 1}</span>
                    {s.label}
                  </button>
                  {i < RECIPE_STAGES.length - 1 && <span className="mx-0.5 h-px w-3 bg-line" />}
                </span>
              ))}
            </div>

            {/* 对话回执 */}
            {transcript.length > 0 && (
              <div className="space-y-1.5">
                {transcript.map((t, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12.5px] text-fg-muted">
                    <Check size={13} className="mt-0.5 shrink-0 text-success" /> <span>{t}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 当前屏 */}
            <div className="card view-enter p-5" key={stage}>
              {stage === 0 && (
                <div className="space-y-4">
                  {assistant(<>先挑一本读过的书当 <b className="font-semibold">骨架</b>。它的结构骨架和编排节奏会被原样搬到新题材上。</>)}
                  <div className="space-y-2">
                    {readyNovels.map((n) => {
                      const m = novelMeta(n);
                      const sel = selectedIds[0] === n.id;
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => pickEngine(n.id)}
                          className={`w-full rounded-lg border p-3 text-left transition-colors ${sel ? 'border-accent bg-surface-2' : 'border-line bg-surface hover:border-fg-subtle'}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                              <span className="truncate text-[13px] font-medium text-fg">{n.name}</span>
                              {!m.dna && <span className="chip shrink-0">旧版DNA</span>}
                              {sel && <Check size={13} className="shrink-0 text-accent-ink" />}
                            </div>
                            <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">{formatWordCount(n.wordCount)}字{m.chapters ? ` · ${m.chapters}章` : ''}</span>
                          </div>
                          {m.beats && <div className="mt-1.5 truncate font-mono text-[11px] text-fg-subtle" title={m.beats}>{m.beats}</div>}
                          {!m.dna && <div className="mt-1.5 text-[11px] text-fg-subtle">旧版 DNA，需先在书架「重新提取」升级为 4 层才能作骨架。</div>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-line-2 pt-3">
                    <span className="min-w-0 truncate text-xs text-fg-subtle">{engineNovel ? `已选《${engineNovel.name}》` : '选一本作骨架后继续'}</span>
                    <button className="btn btn-primary shrink-0 gap-1.5" disabled={!engineNovel} onClick={() => goStage(1)}>下一步 · 选题材 <ArrowRight size={14} /></button>
                  </div>
                </div>
              )}

              {stage === 1 && (
                <div className="space-y-4">
                  {assistant(<>再选一本书当 <b className="font-semibold">题材皮</b>，或跳过——用一句话口述你想要的题材。</>)}
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => pickSkin('')}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${!skinNovel ? 'border-accent bg-surface-2' : 'border-line bg-surface hover:border-fg-subtle'}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-[13px] font-medium text-fg"><Palette size={13} className="text-fg-subtle" /> 不绑题材书 · 用我的口述定题材</span>
                        {!skinNovel && <Check size={13} className="shrink-0 text-accent-ink" />}
                      </div>
                      <div className="mt-1 text-[11px] leading-relaxed text-fg-subtle">系统基于骨架结构，按你下一屏写的方向生成新题材。</div>
                    </button>
                    {readyNovels.filter((n) => n.id !== selectedIds[0]).map((n) => {
                      const m = novelMeta(n);
                      const sel = selectedIds[1] === n.id;
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => pickSkin(n.id)}
                          className={`w-full rounded-lg border p-3 text-left transition-colors ${sel ? 'border-accent bg-surface-2' : 'border-line bg-surface hover:border-fg-subtle'}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                              <span className="truncate text-[13px] font-medium text-fg">{n.name}</span>
                            </span>
                            {sel && <Check size={13} className="shrink-0 text-accent-ink" />}
                          </div>
                          {m.dna?.themeSkin && <div className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-fg-subtle">{m.dna.themeSkin}</div>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-2 pt-3">
                    <div className="flex items-center gap-2">
                      <button className="btn btn-ghost gap-1.5" onClick={() => goStage(0)}><ChevronLeft size={14} /> 上一步</button>
                      {engineNovel && skinNovel && (
                        <button className="btn btn-secondary btn-sm gap-1.5" onClick={swapRoles} title="把骨架和题材对调"><ArrowUpDown size={13} /> 交换骨架/题材</button>
                      )}
                    </div>
                    <button className="btn btn-primary gap-1.5" onClick={() => goStage(2)}>下一步 · 写意图 <ArrowRight size={14} /></button>
                  </div>
                </div>
              )}

              {stage === 2 && (
                <div className="space-y-4">
                  {assistant(<>可选：告诉我方向偏好。留空也行——我会完全依赖两本书的 DNA 自动碰撞。</>)}
                  <div className="space-y-3.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="field-label">生成模式</span>
                      <div className="seg" role="group" aria-label="生成模式">
                        {([{ v: false, label: '换皮变题' }, { v: true, label: '0→1 原创' }] as const).map((opt) => (
                          <button key={String(opt.v)} type="button" onClick={() => setFreedom(opt.v)} aria-pressed={freedom === opt.v} className="seg-item">{opt.label}</button>
                        ))}
                      </div>
                      <span className="text-xs text-fg-muted">{freedom ? '以你的意图为主轴，自由重组结构' : '保持源书结构骨架，只换题材与文风'}</span>
                    </div>
                    <div>
                      <label className="field-label mb-1.5">想往哪些方向写？</label>
                      <input
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        placeholder={skinNovel ? '例如：群像、双男主、悬疑推进…（可留空）' : '用一句话口述题材或方向（不绑题材书时建议填写）'}
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="field-label mb-1.5">想避开什么套路 / 必须保留或禁止的元素？</label>
                      <textarea
                        value={adversarialRules}
                        onChange={(e) => setAdversarialRules(e.target.value)}
                        rows={2}
                        placeholder="例如：禁止废柴逆袭、禁止王子救公主、对手必须有合理动机…（可留空，已内置反套路约束）"
                        className="input"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-line-2 pt-3">
                    <button className="btn btn-ghost gap-1.5" onClick={() => goStage(1)}><ChevronLeft size={14} /> 上一步</button>
                    <button className="btn btn-primary gap-1.5" onClick={() => goStage(3)}>
                      {customPrompt.trim() || adversarialRules.trim() ? '下一步 · 确认配方' : '跳过 · 确认配方'} <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              )}

              {stage === 3 && (
                <div className="space-y-4">
                  {assistant(<>确认配方，我就开始碰撞 <b className="font-semibold">3 个方向</b>。</>)}
                  <div className="divide-y divide-line-2 rounded-lg border border-line bg-panel">
                    {[
                      ['骨架来源', engineNovel ? `结构骨架 + 编排节奏 · 《${engineNovel.name}》` : '未选'],
                      ['题材来源', skinNovel ? `主题皮 + 文风 · 《${skinNovel.name}》` : '口述题材（依赖你的意图）'],
                      ['生成模式', freedom ? '0→1 原创（自由重组）' : '换皮变题（保结构换皮）'],
                      ['创作意图', customPrompt.trim() || '未填写，使用默认（完全依赖 DNA）'],
                      ['反套路约束', adversarialRules.trim() ? `默认启用 · 追加：${adversarialRules.trim()}` : '默认启用（内置反套路）'],
                    ].map(([label, value]) => (
                      <div key={label} className="flex gap-3 px-3.5 py-2.5">
                        <span className="w-16 shrink-0 text-xs text-fg-subtle">{label}</span>
                        <span className="flex-1 break-words text-[13px] text-fg">{value}</span>
                      </div>
                    ))}
                  </div>
                  {recipeErr && <p className="text-sm text-danger">{recipeErr}</p>}
                  <div className="flex items-center justify-between gap-3 border-t border-line-2 pt-3">
                    <button className="btn btn-ghost gap-1.5" onClick={() => goStage(2)}><ChevronLeft size={14} /> 上一步</button>
                    <button className="btn btn-primary btn-lg gap-2" onClick={collide} disabled={colliding || !engineNovel || Boolean(recipeErr)}>
                      <Sparkles size={16} /> {colliding ? '生成中…' : '生成 3 个方向'} <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {errorRow}
            {rateRow}
          </div>

          {/* 右：当前选择摘要（始终可见，实时更新） */}
          <aside className="h-fit lg:sticky lg:top-0">
            <div className="card space-y-3 p-4">
              <div className="eyebrow">配方摘要</div>
              {summaryItem('骨架', engineNovel ? `《${engineNovel.name}》` : '待选', engineNovel ? '结构骨架 + 编排节奏' : undefined)}
              {summaryItem('题材', skinNovel ? `《${skinNovel.name}》` : (engineNovel ? '口述题材' : '待选'), skinNovel ? '主题皮 + 文风' : (engineNovel ? '用你的一句话定题材' : undefined))}
              {summaryItem('模式', freedom ? '0→1 原创' : '换皮变题')}
              {summaryItem('意图', customPrompt.trim() || '未填写 · 用默认')}
              {summaryItem('反套路', adversarialRules.trim() ? '默认启用 · 有追加' : '默认启用')}
              <div className="border-t border-line-2 pt-2.5 text-[11px] leading-relaxed text-fg-subtle">{sourceSummary}。</div>
            </div>
          </aside>
        </div>
      </StudioShell>
    );
  }

  // ===== 候选池（方向）=====
  if (step === 'directions') {
    const idxLabel = ['i.', 'ii.', 'iii.', 'iv.', 'v.', 'vi.', 'vii.', 'viii.', 'ix.', 'x.'];
    const engName = engineNovel?.name || '骨架';
    const skinLabel = skinNovel?.name || '口述题材';
    const dislikedLabels = avoidList.filter((s) => s.startsWith('不喜欢这一类：')).map((s) => s.slice('不喜欢这一类：'.length));
    const rerollBtn = (
      <button className="btn btn-secondary gap-1.5" onClick={() => void rerollDirections()} disabled={colliding}>
        <Shuffle size={14} /> {colliding ? '生成中…' : '再来三条'}
      </button>
    );
    // 当前生成依据（goal）：骨架 × 题材 · 模式 · 偏好 · 锁定 · 避开。
    const basisParts = [
      `${engName} 结构引擎 × ${skinLabel} 题材表皮`,
      freedom ? '0→1 原创' : '换皮变题',
    ];
    if (customPrompt.trim()) basisParts.push(`偏好：${customPrompt.trim()}`);
    if (lockedFeatures.length) basisParts.push(`锁定 ${lockedFeatures.length} 个亮点`);
    if (dislikedLabels.length) basisParts.push(`避开：${dislikedLabels.slice(-3).join('、')}`);
    else if (avoidList.length) basisParts.push(`已避开 ${avoidList.length} 条`);

    return (
      <StudioShell current="directions" nextLabel={nextActionLabel} overlay={directionSwitchDialog}>
        <div className="mx-auto max-w-4xl space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="eyebrow">候选池 · {directions.length} 条</div>
              <h2 className="mt-1 text-base font-semibold text-fg">挑一条、再变体，或换一批。</h2>
              <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-fg-subtle">{basisParts.join(' · ')}</p>
              <p className="mt-0.5 max-w-2xl text-[13px] text-fg-muted">选用其一往下走；不满意可丢弃 / 标不喜欢，「再来三条」会自动避开已弃方向。</p>
            </div>
            {directions.length > 0 && rerollBtn}
          </div>

          {/* 锁定亮点（注入后续生成，必须保留） */}
          {lockedFeatures.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-fg-subtle">锁定亮点</span>
              {lockedFeatures.map((f, i) => (
                <span key={i} className="chip gap-1 text-accent-ink">
                  <Lock size={10} /> <span className="max-w-[240px] truncate" title={f}>{f}</span>
                  <button onClick={() => unlockFeature(i)} className="ml-0.5 text-fg-subtle transition-colors hover:text-danger" aria-label="解除锁定"><X size={11} /></button>
                </span>
              ))}
            </div>
          )}

          {directions.length === 0 ? (
            <div className="card flex flex-col items-center gap-4 p-10 text-center">
              <p className="text-sm text-fg-muted">候选池空了。再抽一批新方向，或回配方对话调整骨架与题材。</p>
              <div className="flex flex-wrap justify-center gap-3">
                {rerollBtn}
                <button className="btn btn-ghost gap-1.5" onClick={() => setStep('material')}><ChevronLeft size={14} /> 回配方对话</button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {directions.map((dir, idx) => {
                const highlight = dir.catalyst?.trim() || dir.concept;
                const locked = lockedFeatures.includes(highlight);
                return (
                  <div key={idx} className="card group relative flex flex-col gap-3 p-5">
                    <button
                      type="button"
                      title="丢弃这条（再来一批会避开）"
                      aria-label="丢弃这条"
                      onClick={() => discardDirection(idx)}
                      className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-raised hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
                    ><X size={14} /></button>
                    <span className="font-mono text-xs text-fg-subtle">{idxLabel[idx] || `${idx + 1}.`}</span>
                    <h4 className="pr-6 text-base font-semibold leading-snug text-fg">{dir.title}</h4>
                    <p className="flex-1 text-[13px] leading-relaxed text-fg-muted">{dir.concept}</p>
                    {dir.catalyst && <p className="flex items-start gap-1.5 text-xs leading-relaxed text-fg-subtle"><Sparkles size={12} className="mt-0.5 shrink-0" /> {dir.catalyst}</p>}
                    {dir.transferNote && <p className="flex items-start gap-1.5 text-xs leading-relaxed text-fg-subtle"><Dna size={12} className="mt-0.5 shrink-0" /> {dir.transferNote}</p>}
                    <div className="flex flex-wrap gap-1.5">
                      <span className="chip">{engName}</span>
                      <span className="chip">{skinLabel}</span>
                    </div>
                    {/* 动作行：选用 / 变体 / 锁亮点 / 不喜欢 */}
                    <div className="mt-0.5 flex items-center gap-0.5 border-t border-line-2 pt-2.5">
                      <button className="btn btn-ghost btn-sm gap-1 text-accent-ink" onClick={() => void chooseDirection(dir)}>选用 <ArrowRight size={12} /></button>
                      <span className="flex-1" />
                      <button className="btn btn-ghost btn-sm btn-icon" title="基于这条再生成几条变体" aria-label="基于这条再变体" disabled={colliding} onClick={() => void variantFromDirection(dir)}><GitBranch size={13} /></button>
                      <button className={`btn btn-ghost btn-sm btn-icon ${locked ? 'text-accent-ink' : ''}`} title={locked ? '亮点已锁定' : '锁定这条亮点，后续生成必须保留'} aria-label="锁定亮点" disabled={locked} onClick={() => lockFeature(highlight)}><Lock size={13} /></button>
                      <button className="btn btn-ghost btn-sm btn-icon hover:text-danger" title="不喜欢，后续避开这一类" aria-label="不喜欢这一类" onClick={() => dislikeDirection(idx)}><ThumbsDown size={13} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {errorRow}
          {rateRow}

          <div className="flex flex-wrap gap-3">
            <button className="btn btn-ghost gap-1.5" onClick={() => setStep('material')}><ChevronLeft size={14} /> 回配方对话</button>
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
      <StudioShell current="creator" nextLabel={nextActionLabel}>
        <div className="mx-auto max-w-5xl space-y-5">
          <div>
            <h2 className="text-base font-semibold text-fg">{selectedDirectionReady ? directionTitle : '定地基，想改就跟我说。'}</h2>
            <p className="mt-1 text-[13px] text-fg-muted">系统已把题材迁移与设定补全做完。确认世界观、主角、对手与叙事语气；AI 改动会直接套用到选中的设定卡，你也可以随时手改。</p>
          </div>

          {repairing && (
            <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-subtle px-3 py-2 text-xs text-accent-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
              正在补洞：核对新题材能否撑起原结构骨架，修补逻辑断裂点…
            </div>
          )}
          {!repairing && repairGaps.length > 0 && (
            <details className="rounded-lg border border-success/35 bg-success-subtle px-3 py-2 text-xs text-success">
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
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-fg"><Wand2 size={14} className="text-accent-ink" /> 与 AI 共创</div>
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
    <StudioShell current="manuscript" nextLabel={nextActionLabel}>
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-6 lg:grid-cols-[1fr_220px]">
          {/* 正文纸 */}
          <div>
            <div className="prose-reader" style={{ fontSize: 30, lineHeight: 1.2, fontWeight: 600 }}>{directionTitle || '新作'} · 第一章</div>
            <div className="mb-6 mt-1.5 font-mono text-[11px] text-fg-subtle">骨架《{engSrc}》 × 题材《{skinSrc}》 · 自动生成</div>
            {comparingDraftIdx !== null && openingDrafts[comparingDraftIdx] ? (
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <div className="eyebrow mb-2">当前版本</div>
                  <div className="prose-reader text-justify" style={{ fontSize: 15, lineHeight: 1.8 }}>{prose || <span className="text-fg-subtle">（空）</span>}</div>
                </div>
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="eyebrow">历史 · {fmtDraftTime(openingDrafts[comparingDraftIdx].createdAt)}</span>
                    <div className="flex gap-1.5">
                      <button className="btn btn-primary btn-sm" onClick={() => restoreOpeningDraft(comparingDraftIdx)}>用这版替换当前</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setComparingDraftIdx(null)}>关闭对比</button>
                    </div>
                  </div>
                  <div className="prose-reader text-justify" style={{ fontSize: 15, lineHeight: 1.8 }}>{openingDrafts[comparingDraftIdx].text}</div>
                </div>
              </div>
            ) : (
              <>
                {/* 开篇 = 第 1 段：保留选句改写 */}
                <div className="prose-reader max-w-[60ch] text-justify" onMouseUp={onProseSelect}>
                  {prose ? <>{prose}{streaming && !prefersReducedMotion && <span className="caret" />}</> : (
                    <span className="text-fg-subtle">{streaming ? '正在生成…' : '点右侧「生成开篇」开始。'}</span>
                  )}
                </div>

                {/* 续写场景（第 2 段起）：连续往下读；仅最后一段可重写/删除 */}
                {continuationNums.map((n) => (
                  <div key={n} className="mt-6 border-t border-line-2 pt-5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="eyebrow">第 {n} 段</span>
                      {n === lastSceneNum && streamingScene === null && (
                        <div className="flex gap-1">
                          <button className="btn btn-ghost btn-sm gap-1" onClick={rewriteLastScene}><RotateCcw size={12} /> 重写本段</button>
                          <button className="btn btn-ghost btn-sm gap-1" onClick={deleteLastScene}><X size={12} /> 删除本段</button>
                        </div>
                      )}
                    </div>
                    <div className="prose-reader max-w-[60ch] text-justify">
                      {sceneTexts[n]}{streamingScene === n && !prefersReducedMotion && <span className="caret" />}
                    </div>
                  </div>
                ))}

                {/* 续写入口（有界：逐次手动、一次一段；无自动章节循环 / 大纲生成 / 一键写到结局）*/}
                {prose.trim() && streamingScene !== OPENING_SCENE_NUM && (
                  <div className="mt-8 border-t border-line pt-5">
                    {streamingScene !== null ? (
                      <div className="flex items-center gap-2 text-[13px] text-accent-ink">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
                        正在写第 {streamingScene} 段…
                        <button className="btn btn-ghost btn-sm gap-1.5" onClick={() => streamAbortRef.current?.abort()}><Square size={13} /> 停止</button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <input
                          value={nextIntent}
                          onChange={(e) => setNextIntent(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') writeNextScene(); }}
                          placeholder="下一段想写什么？（可留空＝自然往下接）"
                          className="input flex-1"
                        />
                        <button className="btn btn-secondary shrink-0 gap-1.5" onClick={writeNextScene}><PenLine size={14} /> 写下一段</button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 工具栏 */}
          <div className="flex flex-col gap-2 lg:sticky lg:top-0">
            <div className="eyebrow">本篇</div>
            <select
              className="input"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              disabled={streaming}
              aria-label="文风寄存器"
              title="文风寄存器：影响成稿语气；选非默认可对抗各题材都被写成统一冷腔"
            >
              {TONE_PRESETS.map((t) => <option key={t.value} value={t.value}>文风 · {t.label}</option>)}
            </select>
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
            <button className="btn btn-secondary justify-start gap-2" onClick={() => void copyManuscript()} disabled={!allProse.trim()}>
              {copied ? <><Check size={14} /> 已复制</> : <><Copy size={14} /> 复制</>}
            </button>
            <button className="btn btn-secondary justify-start gap-2" onClick={exportMd} disabled={!allProse.trim()}><Download size={14} /> 导出 .md</button>
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

            {openingDrafts.length > 0 && (
              <div className="mt-2 space-y-1.5 border-t border-line pt-3">
                <div className="eyebrow">历史版本 · {openingDrafts.length}</div>
                {openingDrafts.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <button
                      className={`min-w-0 flex-1 truncate text-left transition-colors ${comparingDraftIdx === i ? 'text-accent-ink' : 'text-fg-muted hover:text-fg'}`}
                      onClick={() => setComparingDraftIdx(comparingDraftIdx === i ? null : i)}
                      title="对比这版与当前"
                    >
                      <span className="font-mono text-fg-subtle">{fmtDraftTime(d.createdAt)}</span> · {d.text.slice(0, 10)}…
                    </button>
                    <button className="shrink-0 text-fg-subtle hover:text-fg" onClick={() => restoreOpeningDraft(i)} title="恢复这版（当前正文会先存入历史）">恢复</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {errorRow}
        {rateRow}
      </div>
    </StudioShell>
  );
}
