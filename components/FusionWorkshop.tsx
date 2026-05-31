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
  { key: 'protagonistBlock', label: '主角原型', helper: '主角如何欲望驱动、如何承担代价。', icon: Sparkles },
  { key: 'antagonistBlock', label: '对手原型', helper: '谁会制造阻力，阻力来自何处。', icon: Swords },
  { key: 'narrativeTone', label: '叙事色调', helper: '语气、镜头、节奏和情绪的主旋律。', icon: WandSparkles },
];

const STATUS_CHAIN = [
  '正在计算作品之间的风格偏差与冲突来源…',
  '正在模拟世界观与角色动机的碰撞结果…',
  '正在筛掉套路化走向，保留更有生命力的方向…',
  '正在打磨三条可选路线，准备点亮工坊…',
];

function StepBadge({ index, label, active }: { index: number; label: string; active: boolean }) {
  return (
    <div className={`rounded-full border px-3 py-1 text-xs ${active ? 'border-amber-300/30 bg-amber-300/12 text-amber-50' : 'border-white/10 bg-white/[0.03] text-zinc-500'}`}>
      {index}. {label}
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
      setError(err instanceof Error ? err.message : '创意碰撞失败，请重试。');
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
    setTimeout(() => setPulse(new Set()), 1000);
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
      setError(err instanceof Error ? err.message : '调整失败，请重试。');
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
      setError(err instanceof Error ? err.message : '生成故事板失败，请重试。');
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
        [num]: `${previous[num] || ''}\n\n[生成出错: ${err instanceof Error ? err.message : err}]`,
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
      <div className="flex flex-1 items-center justify-center animate-fade-in">
        <div className="glass-card max-w-3xl rounded-[32px] p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-amber-400/20 bg-amber-400/10 text-amber-100 energy-ring">
            <Layers3 className="h-8 w-8" />
          </div>
          <p className="mt-6 text-[11px] uppercase tracking-[0.26em] text-zinc-500">工坊尚未点火</p>
          <h1 className="mt-3 text-3xl font-semibold text-zinc-50">DNA 资产还不够，融合变体阶段暂时不能继续</h1>
          <p className="mt-4 text-base leading-7 text-zinc-300">
            融合变体不是独立功能区，而是前序工作的自然产物。当前只有 {readyNovels.length} 部 DNA 就绪作品，
            还差 {missingReadyCount} 部，无法稳定生成真正有张力的方向卡、故事板与正文变体草案。
          </p>
          <div className="mt-6 grid gap-3 text-left md:grid-cols-4">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">当前阶段</p>
              <p className="mt-2 text-sm text-zinc-100">04 融合变体</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">阻塞原因</p>
              <p className="mt-2 text-sm leading-6 text-zinc-200">DNA 资产不足，无法形成可靠碰撞。</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">修复动作</p>
              <p className="mt-2 text-sm leading-6 text-zinc-200">回到上游，再完成一部作品的 DNA。</p>
            </div>
            <div className="rounded-2xl border border-amber-300/15 bg-amber-300/8 p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/75">完成后得到</p>
              <p className="mt-2 text-sm leading-6 text-amber-50">方向卡、故事板与正文变体草案。</p>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => {
                if (!firstIncompleteNovel) return;
                setWorkshopOpen(false);
                setSelectedNovelId(firstIncompleteNovel.id);
              }}
              className="rounded-2xl border border-amber-300/25 bg-amber-300/14 px-5 py-3 text-sm font-medium text-amber-50 transition-linear hover:bg-amber-300/20"
            >
              去补齐另一部作品的 DNA
            </button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: '融合变体' } }))}
              className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-medium text-zinc-200 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
            >
              先检查模型配置
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'material') {
    return (
      <div className="flex flex-1 flex-col gap-5 animate-fade-in">
        <div className="glass-card rounded-[30px] p-6 panel-grid">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-[11px] uppercase tracking-[0.26em] text-zinc-500">万有引力室 / 多作品融合起点</p>
              <h1 className="mt-3 text-3xl font-semibold text-zinc-50">先选参与碰撞的作品，再决定你想要的变体世界偏航方向</h1>
              <p className="mt-4 text-base leading-7 text-zinc-300">
                这里是变体阶段的第一步。先确认哪些作品要一起发生反应，再决定要不要追加高级约束，而不是先被大文本框打断。
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <StepBadge index={1} label="选择参与作品" active />
              <StepBadge index={2} label="选择融合方向" active={false} />
              <StepBadge index={3} label="高级约束与生成" active={false} />
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.5fr_0.9fr]">
          <div className="glass-card rounded-[30px] p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">步骤 1 / 选材台</p>
                <h2 className="mt-2 text-xl font-semibold text-zinc-50">选择要参与融合的作品</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">输入是至少两部 DNA 就绪作品，输出是一组可继续生成变体方向的素材组合。</p>
              </div>
              <div className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-400">
                已选 {selectedIds.length} / {readyNovels.length}
              </div>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {readyNovels.map((novel) => {
                const selected = selectedIds.includes(novel.id);
                return (
                  <button
                    key={novel.id}
                    onClick={() => toggleNovel(novel.id)}
                    className={`rounded-3xl border p-5 text-left transition-linear ${
                      selected
                        ? 'border-amber-300/30 bg-amber-300/12 shadow-[0_0_0_1px_rgba(247,165,26,0.08)]'
                        : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-lg font-semibold text-zinc-100">{novel.name}</span>
                      {selected ? (
                        <span className="rounded-full border border-amber-300/20 px-2.5 py-1 text-[11px] text-amber-50">已加入</span>
                      ) : (
                        <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-500">可加入</span>
                      )}
                    </div>
                    <p className="mt-3 text-sm leading-6 text-zinc-400 line-clamp-3">{novel.dnaCard?.theme}</p>
                    <div className="mt-4 flex items-center gap-3 text-xs text-zinc-500">
                      <span>{novel.wordCount.toLocaleString()} 字</span>
                      <span>角色与结构已摘要</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="linear-card rounded-[30px] p-5">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">步骤 2 / 高级操控台</p>
            <h3 className="mt-3 text-xl font-semibold text-zinc-50">先用默认流程就够了，只有想精调时再展开</h3>
              <p className="mt-3 text-sm leading-7 text-zinc-400">
                你可以先直接选作品并生成方向。只有在你明确知道“想往哪个极端偏航”时，才需要补充自定义方向和红队约束。
              </p>

            <button
              onClick={() => setAdvancedOpen((value) => !value)}
              className="mt-5 flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-zinc-200 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
            >
              <span>高级操控台</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
            </button>

            {advancedOpen && (
              <div className="mt-4 space-y-3 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
                <textarea
                  value={customPrompt}
                  onChange={(event) => setCustomPrompt(event.target.value)}
                  rows={3}
                  placeholder="可选：告诉工坊你想往哪个方向偏航，例如“把权谋与废土生存压在同一条时间线上”"
                  className="w-full rounded-2xl border border-white/10 bg-[#0b1018] p-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none resize-none"
                />
                <textarea
                  value={adversarialRules}
                  onChange={(event) => setAdversarialRules(event.target.value)}
                  rows={3}
                  placeholder="可选：反套路红队约束，例如“严防宿命论、避免万能外挂与唯心主义捷径”"
                  className="w-full rounded-2xl border border-white/10 bg-[#0b1018] p-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none resize-none"
                />
              </div>
            )}

            {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}

            <div className="mt-5 rounded-3xl border border-amber-300/16 bg-amber-300/8 p-4 text-sm leading-7 text-zinc-300">
              <p className="font-medium text-amber-50">当前推荐路线</p>
              <p className="mt-2">先至少选 2 部作品。如果你是第一次使用，建议先不加高级约束，先看系统给出的 3 条变体路线。</p>
            </div>

            <div className="mt-5">
              {colliding ? (
                <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-50">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {STATUS_CHAIN[statusIdx]}
                  </div>
                </div>
              ) : (
                <button
                  onClick={collide}
                  disabled={selectedIds.length < 2}
                  className="w-full rounded-2xl border border-amber-300/25 bg-amber-300/14 px-5 py-3 text-sm font-medium text-amber-50 transition-linear hover:bg-amber-300/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {selectedIds.length < 2 ? '至少选择 2 部作品' : '启动创意碰撞'}
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
      <div className="flex flex-1 flex-col gap-5 animate-fade-in">
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={() => setStep('material')}
            className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-200 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
          >
            <ArrowLeft className="h-4 w-4" />
            返回选材台
          </button>
          <div className="flex flex-wrap gap-2">
            <StepBadge index={1} label="选择参与作品" active={false} />
            <StepBadge index={2} label="选择融合方向" active />
            <StepBadge index={3} label="高级约束与生成" active={false} />
          </div>
        </div>

        <div className="glass-card rounded-[30px] p-6">
          <p className="text-[11px] uppercase tracking-[0.26em] text-zinc-500">步骤 2 / 选择融合方向</p>
          <h1 className="mt-3 text-3xl font-semibold text-zinc-50">挑一条最值得继续点火的变体世界</h1>
          <p className="mt-3 text-base leading-7 text-zinc-300">
            这一步的输入是已选中的作品组合，输出是可以继续落地的变体方向。下面三条路线会在核心概念、冲突引擎与叙事气质上拉开差异。
          </p>

          <div className="mt-6 grid gap-4 xl:grid-cols-3">
            {directions.map((direction, index) => (
              <button
                key={`${direction.title}-${index}`}
                onClick={() => chooseDirection(direction)}
                className="group rounded-[28px] border border-white/10 bg-white/[0.03] p-5 text-left transition-linear hover:-translate-y-1 hover:border-amber-300/28 hover:bg-white/[0.05]"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">方向 0{index + 1}</span>
                  <Compass className="h-4 w-4 text-zinc-500 transition-linear group-hover:text-amber-100" />
                </div>
                <h2 className="mt-4 text-xl font-semibold leading-8 text-zinc-50">{direction.title}</h2>
                <p className="mt-4 text-sm leading-7 text-zinc-300">{direction.concept}</p>

                <div className="mt-5 rounded-3xl border border-amber-300/15 bg-amber-300/8 p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/75">为什么它值得被选中</p>
                  <p className="mt-2 text-sm leading-6 text-zinc-300">{direction.catalyst}</p>
                </div>

                <div className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-amber-100">
                  点亮这条变体路线
                  <ArrowLeft className="h-4 w-4 rotate-180" />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-zinc-500">步骤 3 / 高级约束与生成</p>
          <h1 className="mt-3 text-3xl font-semibold text-zinc-50">{directionTitle}</h1>
          <p className="mt-3 text-base leading-7 text-zinc-300">
            这一步会把方向卡继续推进为故事板和正文变体草案。左边管设定，右边管输出，底部命令栏负责微调。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setStep('directions')}
            className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-200 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
          >
            <ArrowLeft className="h-4 w-4" />
            重选方向
          </button>
          <StepBadge index={3} label="高级约束与生成" active />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-5 xl:grid-cols-[1.05fr_1fr]">
        <div className="flex min-h-0 flex-col gap-5">
          <div className="glass-card rounded-[30px] p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">设定块</p>
                <h2 className="mt-2 text-xl font-semibold text-zinc-50">先把变体世界的骨架钉牢</h2>
              </div>
              <button
                onClick={() => setAdvancedOpen((value) => !value)}
                className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-200 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
              >
                高级约束
                <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {advancedOpen && (
              <div className="mt-5 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                <textarea
                  value={adversarialRules}
                  onChange={(event) => setAdversarialRules(event.target.value)}
                  rows={3}
                  placeholder="这里可以继续补充红队约束，告诉工坊什么方向一定不能走。"
                  className="w-full rounded-2xl border border-white/10 bg-[#0b1018] p-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none resize-none"
                />
              </div>
            )}

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {BLOCKS.map(({ key, label, helper, icon: Icon }) => (
                <div
                  key={key}
                  className={`rounded-3xl border bg-white/[0.03] p-5 transition-linear ${pulse.has(key) ? 'pulse-cyan border-cyan-300/30' : 'border-white/10'}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl border border-cyan-300/18 bg-cyan-300/10 p-2.5 text-cyan-100">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-zinc-100">{label}</p>
                      <p className="text-xs text-zinc-500">{helper}</p>
                    </div>
                  </div>
                  <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-zinc-200">{blocks[key]}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="shrink-0 glass-card rounded-[28px] px-4 py-3">
            <div className="flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-amber-100" />
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runTweak();
                }}
                placeholder="输入一句话微调设定，例如“让主角的代价从肉体转向记忆”"
                className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
              />
              <button
                onClick={runTweak}
                disabled={tweaking || !command.trim()}
                className="rounded-2xl border border-amber-300/20 bg-amber-300/12 p-2.5 text-amber-50 transition-linear hover:bg-amber-300/18 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {tweaking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-5">
          <div className="glass-card flex min-h-0 flex-1 flex-col rounded-[30px] p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">故事板与落文</p>
                <h2 className="mt-2 text-xl font-semibold text-zinc-50">先有场景骨架，再有正文输出</h2>
              </div>
              <button
                onClick={generateStoryboard}
                disabled={generatingBoard}
                className="inline-flex items-center gap-2 rounded-2xl border border-amber-300/20 bg-amber-300/12 px-4 py-2.5 text-sm font-medium text-amber-50 transition-linear hover:bg-amber-300/18 disabled:opacity-50"
              >
                {generatingBoard ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
                {storyboard.length ? '重新生成故事板' : '生成故事板'}
              </button>
            </div>

            <div className="mt-5 flex-1 overflow-y-auto">
              {storyboard.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center rounded-[28px] border border-dashed border-white/10 bg-white/[0.02] px-6 py-10 text-center">
                  <Film className="h-8 w-8 text-zinc-500" />
                  <p className="mt-4 text-lg font-semibold text-zinc-100">故事板还没生成</p>
                  <p className="mt-2 max-w-md text-sm leading-7 text-zinc-400">
                    先让工坊生成 3 幕分镜，确认节奏与冲突是否成立，再逐幕落成正文。
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {storyboard.map((scene) => (
                    <div key={scene.sceneNumber} className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Scene {scene.sceneNumber}</p>
                          <h3 className="mt-2 text-lg font-semibold text-zinc-100">{scene.sceneTitle}</h3>
                        </div>
                        <button
                          onClick={() => generateScene(scene)}
                          disabled={streamingScene !== null}
                          className="inline-flex items-center gap-2 rounded-2xl border border-cyan-300/18 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-50 transition-linear hover:bg-cyan-300/16 disabled:opacity-50"
                        >
                          {streamingScene === scene.sceneNumber ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenTool className="h-4 w-4" />}
                          动笔生成
                        </button>
                      </div>

                      <p className="mt-3 text-sm leading-7 text-zinc-300">{scene.plotOutline}</p>
                      <div className="mt-4 flex flex-wrap gap-4 text-xs text-zinc-500">
                        <span>张力：{scene.tensionLevel}</span>
                        <span>视觉提示：{scene.visualCues}</span>
                      </div>

                      {sceneTexts[scene.sceneNumber] !== undefined && (
                        <div className="mt-5 border-t border-white/8 pt-4">
                          <div className="mb-3 flex items-center justify-end gap-2">
                            <button
                              onClick={() => copyScene(scene.sceneNumber)}
                              className="inline-flex items-center gap-1 rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-300 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
                            >
                              {copied === scene.sceneNumber ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                              复制
                            </button>
                            <button
                              onClick={() => saveScene(scene)}
                              className="inline-flex items-center gap-1 rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-300 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
                            >
                              <Download className="h-3.5 w-3.5" />
                              保存
                            </button>
                          </div>
                          <p className="whitespace-pre-wrap text-[15px] leading-loose text-zinc-200">
                            {sceneTexts[scene.sceneNumber]}
                            {streamingScene === scene.sceneNumber && (
                              <span className="ml-1 inline-block h-4 w-1.5 animate-pulse rounded-full bg-amber-300 align-middle" />
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
          {error && <p className="text-sm text-rose-300">{error}</p>}
        </div>
      </div>
    </div>
  );
}
