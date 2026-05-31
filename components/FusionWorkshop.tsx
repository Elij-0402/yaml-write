'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clapperboard,
  Compass,
  Copy,
  Download,
  Film,
  Globe,
  Layers3,
  Loader2,
  PenTool,
  Send,
  Sparkles,
  Swords,
  WandSparkles,
} from 'lucide-react';
import { db } from '../app/db';
import { ensureLlmConfigReady, postWithLlmConfig, readApiErrorMessage, streamSse } from '../app/llmClient';
import { useAppStore } from '../app/store';

interface FusionDirection {
  title: string;
  concept: string;
  catalyst: string;
  worldviewBlock: string;
  protagonistBlock: string;
  antagonistBlock: string;
  narrativeTone: string;
}

interface StoryboardScene {
  sceneNumber: number;
  sceneTitle: string;
  plotOutline: string;
  tensionLevel: string;
  visualCues: string;
}

type BlockKey = 'worldviewBlock' | 'protagonistBlock' | 'antagonistBlock' | 'narrativeTone';

const BLOCKS: { key: BlockKey; label: string; helper: string; icon: typeof Globe }[] = [
  { key: 'worldviewBlock', label: '世界观规约', helper: '哪些法则真正控制这个变体世界。', icon: Globe },
  { key: 'protagonistBlock', label: '主角灵魂原型', helper: '主角如何欲望驱动、如何承担代价。', icon: Sparkles },
  { key: 'antagonistBlock', label: '对手原型体系', helper: '谁会制造阻力，阻力来自何处。', icon: Swords },
  { key: 'narrativeTone', label: '叙事色调气质', helper: '语气、镜头、节奏和情绪的主旋律。', icon: WandSparkles },
];

const STATUS_CHAIN = [
  '正在计算作品之间的风格偏差与冲突来源…',
  '正在模拟世界观与角色动机的碰撞结果…',
  '正在筛掉套路化走向，保留更有生命力的方向…',
  '正在打磨三条可选路线，准备点亮工坊…',
];

const PRESETS = [
  { label: '加深冲突张力', cmd: '加深角色之间的核心冲突与命运张力' },
  { label: '弱化幻想设定', cmd: '弱化科幻或奇幻设定，将核心聚焦于现实与人性冲突' },
  { label: '增加悬疑冷冽感', cmd: '为故事板和文风注入更浓郁的悬疑、冷峻与黑色电影（Noir）色调' },
  { label: '让代价转向记忆', cmd: '让主角面临的重大代价由生理性创伤转向宿命般丢失的记忆' },
];

function StepBadge({ index, label, active }: { index: number; label: string; active: boolean }) {
  return (
    <div className={`rounded-full border px-3 py-1 text-[10px] font-mono ${
      active 
        ? 'border-white/10 bg-white/[0.03] text-zinc-100' 
        : 'border-white/5 bg-transparent text-zinc-600'
    }`}>
      0{index}. {label}
    </div>
  );
}

export default function FusionWorkshop() {
  const { setSelectedNovelId, setWorkshopOpen } = useAppStore((state) => ({
    setSelectedNovelId: state.setSelectedNovelId,
    setWorkshopOpen: state.setWorkshopOpen,
  }));
  const novels = useLiveQuery(() => db.novels.reverse().toArray(), []) || [];
  const readyNovels = novels.filter((novel) => novel.analysisStatus === 'done' && novel.dnaCard);
  const missingReadyCount = Math.max(0, 2 - readyNovels.length);
  const firstIncompleteNovel = novels.find((novel) => novel.analysisStatus !== 'done' || !novel.dnaCard) || novels[0] || null;

  const [step, setStep] = useState<'material' | 'directions' | 'creator'>('material');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [adversarialRules, setAdversarialRules] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [colliding, setColliding] = useState(false);
  const [statusIdx, setStatusIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [directions, setDirections] = useState<FusionDirection[]>([]);
  const [blocks, setBlocks] = useState<Record<BlockKey, string>>({
    worldviewBlock: '',
    protagonistBlock: '',
    antagonistBlock: '',
    narrativeTone: '',
  });
  const [directionTitle, setDirectionTitle] = useState('');
  const [pulse, setPulse] = useState<Set<BlockKey>>(new Set());
  const [command, setCommand] = useState('');
  const [tweaking, setTweaking] = useState(false);
  const [storyboard, setStoryboard] = useState<StoryboardScene[]>([]);
  const [generatingBoard, setGeneratingBoard] = useState(false);
  const [sceneTexts, setSceneTexts] = useState<Record<number, string>>({});
  const [streamingScene, setStreamingScene] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    if (!colliding) return;
    const timer = setInterval(() => setStatusIdx((index) => (index + 1) % STATUS_CHAIN.length), 1800);
    return () => clearInterval(timer);
  }, [colliding]);

  const selectedReadyNovels = useMemo(
    () => selectedIds.map((id) => readyNovels.find((novel) => novel.id === id)).filter(Boolean),
    [readyNovels, selectedIds]
  );

  const guardLlm = (): boolean => {
    const readiness = ensureLlmConfigReady();
    if (!readiness.ok) {
      window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: '融合变体' } }));
      return false;
    }
    return true;
  };

  const toggleNovel = (id: string) => {
    setSelectedIds((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]));
  };

  const collide = async () => {
    if (!guardLlm() || selectedIds.length < 2) return;
    setError(null);
    setColliding(true);
    setStatusIdx(0);
    try {
      const dnaCards = selectedIds
        .map((id) => readyNovels.find((novel) => novel.id === id))
        .filter(Boolean)
        .map((novel) => ({ novelName: novel!.name, ...novel!.dnaCard! }));
      const response = await postWithLlmConfig('/api/py/generate-fusion-directions', {
        dnaCards,
        userCustomPrompt: customPrompt.trim() || undefined,
        adversarialRules: adversarialRules.trim() || undefined,
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response));
      const data = (await response.json()) as { directions: FusionDirection[] };
      setDirections(data.directions || []);
      setStep('directions');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创意碰撞评估失败，请重试。');
    } finally {
      setColliding(false);
    }
  };

  const chooseDirection = (direction: FusionDirection) => {
    setDirectionTitle(direction.title);
    setBlocks({
      worldviewBlock: direction.worldviewBlock,
      protagonistBlock: direction.protagonistBlock,
      antagonistBlock: direction.antagonistBlock,
      narrativeTone: direction.narrativeTone,
    });
    setStoryboard([]);
    setSceneTexts({});
    setStep('creator');
  };

  const flashPulse = (keys: BlockKey[]) => {
    setPulse(new Set(keys));
    setTimeout(() => setPulse(new Set()), 1200);
  };

  const runTweak = async () => {
    if (!guardLlm() || !command.trim() || tweaking) return;
    setError(null);
    setTweaking(true);
    try {
      const response = await postWithLlmConfig('/api/py/tweak-fusion-blocks', {
        ...blocks,
        userInstruction: command.trim(),
        adversarialRules: adversarialRules.trim() || undefined,
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response));
      const data = (await response.json()) as Partial<Record<BlockKey, string>> & { modifiedBlocks: BlockKey[] };
      const changed: BlockKey[] = [];
      setBlocks((previous) => {
        const next = { ...previous };
        (data.modifiedBlocks || []).forEach((key) => {
          if (typeof data[key] === 'string') {
            next[key] = data[key] as string;
            changed.push(key);
          }
        });
        return next;
      });
      flashPulse(changed);
      setCommand('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '变体精调调整失败，请重试。');
    } finally {
      setTweaking(false);
    }
  };

  const selectedDirection = () => ({ title: directionTitle, ...blocks });

  const generateStoryboard = async () => {
    if (!guardLlm()) return;
    setError(null);
    setGeneratingBoard(true);
    try {
      const response = await postWithLlmConfig('/api/py/generate-storyboard', {
        selectedDirection: selectedDirection(),
        sceneCount: 3,
        adversarialRules: adversarialRules.trim() || undefined,
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response));
      const data = (await response.json()) as { scenes: StoryboardScene[] };
      setStoryboard(data.scenes || []);
      setSceneTexts({});
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成分镜故事板失败，请重试。');
    } finally {
      setGeneratingBoard(false);
    }
  };

  const generateScene = async (scene: StoryboardScene) => {
    if (!guardLlm() || streamingScene !== null) return;
    const num = scene.sceneNumber;
    const precedingTexts: Record<number, string> = {};
    [num - 2, num - 1].forEach((n) => {
      if (n >= 1 && sceneTexts[n]) precedingTexts[n] = sceneTexts[n];
    });
    setSceneTexts((previous) => ({ ...previous, [num]: '' }));
    setStreamingScene(num);
    try {
      await streamSse(
        '/api/py/stream-scene-text',
        {
          selectedDirection: selectedDirection(),
          currentScene: scene,
          precedingTexts,
          adversarialRules: adversarialRules.trim() || undefined,
        },
        {
          onDelta: (text) => setSceneTexts((previous) => ({ ...previous, [num]: (previous[num] || '') + text })),
        }
      );
    } catch (err) {
      setSceneTexts((previous) => ({
        ...previous,
        [num]: `${previous[num] || ''}\n\n[生成发生阻碍: ${err instanceof Error ? err.message : err}]`,
      }));
    } finally {
      setStreamingScene(null);
    }
  };

  const copyScene = (num: number) => {
    navigator.clipboard.writeText(sceneTexts[num] || '');
    setCopied(num);
    setTimeout(() => setCopied(null), 1500);
  };

  const saveScene = (scene: StoryboardScene) => {
    const blob = new Blob([sceneTexts[scene.sceneNumber] || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${scene.sceneTitle || 'scene'}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (readyNovels.length < 2) {
    return (
      <div className="flex flex-1 items-center justify-center animate-fade-in bg-[#000000]">
        <div className="glass-card max-w-3xl rounded-2xl p-8 text-center border-white/5 bg-zinc-950/60">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/[0.02] text-zinc-300">
            <Layers3 className="h-5 w-5" />
          </div>
          <p className="mt-6 text-[10px] font-mono tracking-widest text-zinc-500 uppercase">工坊未开启</p>
          <h1 className="mt-3 text-2xl font-semibold text-zinc-100 tracking-tight">创意融合工坊尚需 DNA 原料依赖</h1>
          <p className="mt-2.5 text-xs leading-relaxed text-zinc-400 max-w-2xl mx-auto">
            创意变体融合基于上游的 DNA 提炼资产。当前数据库中仅有 {readyNovels.length} 部 DNA 就绪作品，还差 {missingReadyCount} 部。
            请先将两本及以上的 TXT 长篇小说提炼出 DNA 后再点亮本工坊。
          </p>
          <div className="mt-6 grid gap-3 text-left grid-cols-2 md:grid-cols-4 text-xs font-mono">
            <div className="rounded-xl border border-white/5 bg-white/[0.01] p-4">
              <p className="text-[9px] text-zinc-650 uppercase">当前阶段</p>
              <p className="mt-1.5 text-zinc-300 font-sans font-medium">04 融合变体</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.01] p-4">
              <p className="text-[9px] text-zinc-650 uppercase">阻碍原因</p>
              <p className="mt-1.5 text-zinc-300 font-sans">DNA 库不足以拟合碰撞。</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.01] p-4">
              <p className="text-[9px] text-zinc-650 uppercase">修正动作</p>
              <p className="mt-1.5 text-zinc-300 font-sans">提炼另一部项目的 DNA。</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <p className="text-[9px] text-zinc-500 uppercase">完成后获得</p>
              <p className="mt-1.5 text-zinc-200 font-sans font-medium">分镜故事板与流式正文。</p>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => {
                if (!firstIncompleteNovel) return;
                setWorkshopOpen(false);
                setSelectedNovelId(firstIncompleteNovel.id);
              }}
              className="rounded-xl border border-white/10 bg-white/[0.04] px-5 py-2.5 text-xs font-semibold text-white transition-linear hover:bg-white/[0.08]"
            >
              去补齐另一部原稿的 DNA
            </button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: '融合变体' } }))}
              className="rounded-xl border border-white/5 bg-white/[0.015] px-5 py-2.5 text-xs font-semibold text-zinc-300 transition-linear hover:border-white/10 hover:bg-white/[0.03]"
            >
              前去模型配置检查
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'material') {
    return (
      <div className="flex flex-1 flex-col gap-5 animate-fade-in">
        <div className="glass-card rounded-2xl p-6 panel-grid border-white/5 bg-zinc-950/60">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-[10px] font-mono tracking-widest text-zinc-500 uppercase">第一阶段 / 万有引力室</p>
              <h1 className="mt-2 text-2xl font-semibold text-zinc-100 tracking-tight">选定碰撞作品组合，设定偏航大方向</h1>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                从库内选取至少两部已生成 DNA 骨架的小说进行融合。您可以根据需求在高级面板注入偏航方向，碰撞算法将给出三条全然不同的原创路线。
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <StepBadge index={1} label="素材选择" active />
              <StepBadge index={2} label="路线筛选" active={false} />
              <StepBadge index={3} label="设定打磨" active={false} />
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.5fr_0.9fr]">
          <div className="glass-card rounded-2xl p-6 border-white/5 bg-zinc-950/60">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">步骤 1 / 选取输入资产</p>
                <h2 className="mt-1 text-sm font-semibold text-zinc-200">选择参与融合的原稿项目</h2>
              </div>
              <div className="rounded-full border border-white/5 bg-white/[0.01] px-3 py-0.5 text-[10px] font-mono text-zinc-450">
                SELECTED: {selectedIds.length} / {readyNovels.length}
              </div>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {readyNovels.map((novel) => {
                const selected = selectedIds.includes(novel.id);
                return (
                  <button
                    key={novel.id}
                    onClick={() => toggleNovel(novel.id)}
                    className={`rounded-2xl border p-5 text-left transition-linear ${
                      selected
                        ? 'border-zinc-700 bg-zinc-900/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]'
                        : 'border-white/5 bg-white/[0.015] hover:border-white/10 hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm font-semibold text-zinc-200">{novel.name}</span>
                      {selected ? (
                        <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 text-[9px] font-mono text-zinc-200">ACTIVE</span>
                      ) : (
                        <span className="rounded-full border border-white/5 px-2.5 py-0.5 text-[9px] font-mono text-zinc-600">IDLE</span>
                      )}
                    </div>
                    <p className="mt-3 text-xs leading-relaxed text-zinc-500 line-clamp-3 font-serif">{novel.dnaCard?.theme}</p>
                    <div className="mt-4 flex items-center gap-3 text-[10px] text-zinc-650 font-mono">
                      <span>{novel.wordCount.toLocaleString()} 字</span>
                      <span>DNA_MAPPED</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="linear-card rounded-2xl p-5 border-white/5 bg-zinc-950/20">
            <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">步骤 2 / 偏航微调台</p>
            <h3 className="mt-2 text-sm font-semibold text-zinc-200">注入创意偏航指令与防套路红队规则</h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              默认碰撞会自动拉开最大架构差异。如果您有独特的碰撞意图，可以在下方高级操控台注入具体偏航引导和黑名单规约。
            </p>

            <button
              onClick={() => setAdvancedOpen((value) => !value)}
              className="mt-5 flex w-full items-center justify-between rounded-xl border border-white/5 bg-white/[0.015] px-4 py-2.5 text-xs font-medium text-zinc-350 transition-linear hover:border-white/10 hover:bg-white/[0.03]"
            >
              <span>高级操控选项面板</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${advancedOpen ? 'rotate-180' : ''}`} />
            </button>

            {advancedOpen && (
              <div className="mt-4 space-y-3 rounded-xl border border-white/5 bg-white/[0.01] p-4 text-xs">
                <textarea
                  value={customPrompt}
                  onChange={(event) => setCustomPrompt(event.target.value)}
                  rows={3}
                  placeholder="可选：引导碰撞走向，例如“把诡异废土的生存挣扎与高墙内部的权谋博弈压在同一条时间线上”..."
                  className="w-full rounded-xl border border-white/5 bg-zinc-950 p-3 text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none resize-none"
                />
                <textarea
                  value={adversarialRules}
                  onChange={(event) => setAdversarialRules(event.target.value)}
                  rows={3}
                  placeholder="可选：反套路红队规约，例如“严防宿命论、避免万能外挂与唯心主义捷径，强化逻辑硬核感”..."
                  className="w-full rounded-xl border border-white/5 bg-zinc-950 p-3 text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none resize-none"
                />
              </div>
            )}

            {error && <p className="mt-4 text-xs font-mono text-rose-400">{error}</p>}

            <div className="mt-5 rounded-xl border border-white/5 bg-white/[0.01] p-4 text-xs leading-relaxed text-zinc-500">
              <p className="font-semibold text-zinc-400">初次使用建议</p>
              <p className="mt-1">首次碰撞建议先不添加任何偏向与规约，让大模型自适应评估多视角题材的离散碰撞方向，以获得最优创意惊喜感。</p>
            </div>

            <div className="mt-5">
              {colliding ? (
                <div className="rounded-xl border border-white/5 bg-zinc-950/40 p-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between text-xs text-zinc-400 font-mono">
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                        COLLIDING...
                      </span>
                    </div>
                    <div className="linear-loader-container rounded-full">
                      <div className="linear-loader-bar rounded-full" />
                    </div>
                    <span className="text-[11px] text-zinc-500 font-sans tracking-tight">{STATUS_CHAIN[statusIdx]}</span>
                  </div>
                </div>
              ) : (
                <button
                  onClick={collide}
                  disabled={selectedIds.length < 2}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.02] px-5 py-3 text-xs font-semibold text-white transition-linear hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {selectedIds.length < 2 ? '请至少选择 2 部作品立项' : '启动创意碰撞反应'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'directions') {
    return (
      <div className="flex flex-1 flex-col gap-5 animate-fade-in bg-[#000000]">
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={() => setStep('material')}
            className="inline-flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.015] px-4 py-2 text-xs font-medium text-zinc-400 transition-linear hover:border-white/10 hover:text-zinc-200"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回万有引力室
          </button>
          <div className="flex flex-wrap gap-2">
            <StepBadge index={1} label="素材选择" active={false} />
            <StepBadge index={2} label="路线筛选" active />
            <StepBadge index={3} label="设定打磨" active={false} />
          </div>
        </div>

        <div className="glass-card rounded-2xl p-6 border-white/5 bg-zinc-950/60">
          <p className="text-[10px] font-mono tracking-widest text-zinc-500 uppercase">第二阶段 / 融合路线评筛</p>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-100 tracking-tight">选定一条具备核心张力的原创变体世界</h1>
          <p className="mt-2 text-xs leading-relaxed text-zinc-400 max-w-3xl">
            碰撞算法已将导入的 DNA 做自适应交叉分析，生成了 3 条完全不同的变体拟合走向。请审阅三者核心概念、冲突发动机与题材厚度，并点亮一条以开启微调与正文故事板分镜。
          </p>

          <div className="mt-6 grid gap-5 xl:grid-cols-3">
            {directions.map((direction, index) => (
              <button
                key={`${direction.title}-${index}`}
                onClick={() => chooseDirection(direction)}
                className="group rounded-2xl border border-white/5 bg-white/[0.01] p-5 text-left transition-linear hover:border-white/15 hover:bg-white/[0.02]"
              >
                <div className="flex items-center justify-between gap-3 font-mono">
                  <span className="text-[9px] text-zinc-500 uppercase tracking-widest">DIRECTION 0{index + 1}</span>
                  <Compass className="h-4 w-4 text-zinc-650 transition-linear group-hover:text-white" />
                </div>
                <h2 className="mt-4 text-base font-semibold leading-relaxed text-zinc-200 tracking-tight">{direction.title}</h2>
                <p className="mt-3 text-xs leading-relaxed text-zinc-400">{direction.concept}</p>

                <div className="mt-5 rounded-xl border border-white/5 bg-white/[0.01] p-4">
                  <p className="text-[9px] font-mono tracking-wider text-zinc-500 uppercase">核心冲突发动机</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-400 font-serif">{direction.catalyst}</p>
                </div>

                <div className="mt-5 inline-flex items-center gap-1.5 text-xs font-semibold text-white">
                  选定并点亮此变体
                  <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 animate-fade-in bg-[#000000]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-mono tracking-widest text-zinc-500 uppercase">第三阶段 / 设定与正文生成</p>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-100 tracking-tight">{directionTitle}</h1>
          <p className="mt-2 text-xs leading-relaxed text-zinc-400 max-w-3xl">
            本页承担核心变体打磨任务。左侧大卡为 4 大设定骨架块，您可以利用底部的精密命令行发送微调指令；右侧则为您生成核心场景故事板与流式正文。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setStep('directions')}
            className="inline-flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.015] px-4 py-2.5 text-xs font-medium text-zinc-400 transition-linear hover:border-white/10 hover:text-zinc-200"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            重选融合走向
          </button>
          <StepBadge index={3} label="设定打磨与正文" active />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-5 xl:grid-cols-[1.05fr_1fr]">
        <div className="flex min-h-0 flex-col gap-5">
          <div className="glass-card rounded-2xl p-6 border-white/5 bg-zinc-950/60">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">世界设定体系</p>
                <h2 className="mt-1 text-sm font-semibold text-zinc-200">打磨并锁定变体设定骨架</h2>
              </div>
              <button
                onClick={() => setAdvancedOpen((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/5 bg-white/[0.015] px-3.5 py-2 text-xs font-medium text-zinc-350 transition-linear hover:border-white/10 hover:bg-white/[0.03]"
              >
                追加红队规约
                <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${advancedOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {advancedOpen && (
              <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.015] p-4">
                <textarea
                  value={adversarialRules}
                  onChange={(event) => setAdversarialRules(event.target.value)}
                  rows={3}
                  placeholder="追加不可涉足的禁区与约束，例如：“严防纯逻辑外挂、杜绝无端洗白与圣母走向”..."
                  className="w-full rounded-xl border border-white/5 bg-zinc-950 p-3 text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none resize-none font-mono"
                />
              </div>
            )}

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {BLOCKS.map(({ key, label, helper, icon: Icon }) => (
                <div
                  key={key}
                  className={`rounded-xl border bg-white/[0.01] p-5 transition-linear ${
                    pulse.has(key) ? 'pulse-zinc border-white/20' : 'border-white/5'
                  }`}
                >
                  <div className="flex items-center gap-3 border-b border-white/[0.02] pb-3">
                    <div className="rounded-xl border border-white/5 bg-white/[0.015] p-2 text-zinc-300">
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-zinc-250">{label}</p>
                      <p className="text-[10px] text-zinc-600 font-mono uppercase">SETTING_BLOCK</p>
                    </div>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400 font-serif">{blocks[key]}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Raycast-style Command Bar & Creative Pills */}
          <div className="shrink-0 glass-card rounded-2xl px-5 py-4 border-white/5 bg-zinc-950/60 shadow-2xl flex flex-col">
            <div className="flex items-center gap-3">
              <Sparkles className="h-4.5 w-4.5 text-zinc-400" />
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runTweak();
                }}
                placeholder="键入一句偏航或微调指令，例如“让主角的痛苦由肉体创伤转向缺失的宿命记忆”"
                className="flex-1 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none font-mono"
              />
              <span className="hidden sm:inline-flex h-5 items-center gap-0.5 rounded border border-white/10 bg-white/[0.02] px-1.5 font-mono text-[9px] font-medium text-zinc-500">Ctrl ↵</span>
              <button
                onClick={runTweak}
                disabled={tweaking || !command.trim()}
                className="rounded-xl border border-white/10 bg-white/[0.02] p-2 text-zinc-200 transition-linear hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {tweaking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </button>
            </div>

            {/* Clickable Quick Creative Pills */}
            <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.02] pt-3">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setCommand(p.cmd)}
                  className="rounded-full border border-white/5 bg-white/[0.01] px-2.5 py-1 text-[10px] text-zinc-550 transition-linear hover:border-white/15 hover:text-zinc-300"
                >
                  ✦ {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-5">
          <div className="glass-card flex min-h-0 flex-1 flex-col rounded-2xl p-6 border-white/5 bg-zinc-950/60">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-4">
              <div>
                <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">分镜故事板与正文落文</p>
                <h2 className="mt-1 text-sm font-semibold text-zinc-200">生成分镜大纲，逐一落笔成文</h2>
              </div>
              <button
                onClick={generateStoryboard}
                disabled={generatingBoard}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs font-semibold text-zinc-200 transition-linear hover:bg-white/[0.05] disabled:opacity-50"
              >
                {generatingBoard ? (
                  <div className="linear-loader-container rounded-full w-[20px]">
                    <div className="linear-loader-bar rounded-full" />
                  </div>
                ) : (
                  <Clapperboard className="h-3.5 w-3.5" />
                )}
                {storyboard.length ? '重设分镜故事板' : '智能生成分镜故事板'}
              </button>
            </div>

            <div className="mt-5 flex-1 overflow-y-auto pr-0.5">
              {storyboard.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-white/5 bg-white/[0.01] px-6 py-10 text-center">
                  <Film className="h-6 w-6 text-zinc-550" />
                  <p className="mt-4 text-sm font-semibold text-zinc-200">大纲分镜故事板待点亮</p>
                  <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-zinc-500">
                    点击右上角让工坊率先规划 3 幕分镜大纲，审查情绪张力与情节离散度是否合理，再落笔流式抽取精美正文。
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {storyboard.map((scene) => (
                    <div key={scene.sceneNumber} className="rounded-xl border border-white/5 bg-zinc-950/20 p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.02] pb-3">
                        <div>
                          <p className="text-[9px] font-mono tracking-wider text-zinc-500 uppercase">SCENE 0{scene.sceneNumber}</p>
                          <h3 className="mt-1 text-sm font-semibold text-zinc-200 tracking-tight">{scene.sceneTitle}</h3>
                        </div>
                        <button
                          onClick={() => generateScene(scene)}
                          disabled={streamingScene !== null}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2 text-xs font-semibold text-zinc-300 transition-linear hover:bg-white/[0.05] disabled:opacity-40"
                        >
                          {streamingScene === scene.sceneNumber ? (
                            <div className="linear-loader-container rounded-full w-[24px]">
                              <div className="linear-loader-bar rounded-full" />
                            </div>
                          ) : (
                            <PenTool className="h-3.5 w-3.5" />
                          )}
                          落笔生成
                        </button>
                      </div>

                      <p className="mt-3 text-xs leading-relaxed text-zinc-400">{scene.plotOutline}</p>
                      <div className="mt-4 flex flex-wrap gap-4 text-[10px] text-zinc-600 font-mono">
                        <span>张力级别: {scene.tensionLevel}</span>
                        <span>画面提示词: {scene.visualCues}</span>
                      </div>

                      {sceneTexts[scene.sceneNumber] !== undefined && (
                        <div className="mt-5 border-t border-white/5 pt-4">
                          <div className="mb-3 flex items-center justify-end gap-2">
                            <button
                              onClick={() => copyScene(scene.sceneNumber)}
                              className="inline-flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.01] px-2.5 py-1 text-[10px] text-zinc-400 transition-linear hover:border-white/15 hover:bg-white/[0.02]"
                            >
                              {copied === scene.sceneNumber ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                              复制
                            </button>
                            <button
                              onClick={() => saveScene(scene)}
                              className="inline-flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.01] px-2.5 py-1 text-[10px] text-zinc-400 transition-linear hover:border-white/15 hover:bg-white/[0.02]"
                            >
                              <Download className="h-3 w-3" />
                              导出
                            </button>
                          </div>
                          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-300 font-serif">
                            {sceneTexts[scene.sceneNumber]}
                            {streamingScene === scene.sceneNumber && (
                              <span className="ml-1 inline-block h-3.5 w-1 bg-zinc-200 animate-pulse align-middle" />
                            )}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {error && <p className="text-xs font-mono text-rose-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}
