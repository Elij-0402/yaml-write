'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  Loader2,
  Send,
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

const BLOCKS: { key: BlockKey; label: string }[] = [
  { key: 'worldviewBlock', label: '世界观' },
  { key: 'protagonistBlock', label: '主角' },
  { key: 'antagonistBlock', label: '对手' },
  { key: 'narrativeTone', label: '叙事' },
];

const PRESETS = [
  { label: '加深冲突', cmd: '加深角色之间的核心冲突与命运张力' },
  { label: '弱化幻想', cmd: '弱化科幻或奇幻设定，聚焦现实与人性' },
  { label: '增加悬疑', cmd: '注入悬疑、冷峻的黑色电影色调' },
];

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [colliding, setColliding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [directions, setDirections] = useState<FusionDirection[]>([]);
  const [blocks, setBlocks] = useState<Record<BlockKey, string>>({
    worldviewBlock: '',
    protagonistBlock: '',
    antagonistBlock: '',
    narrativeTone: '',
  });
  const [directionTitle, setDirectionTitle] = useState('');
  const [command, setCommand] = useState('');
  const [tweaking, setTweaking] = useState(false);
  const [storyboard, setStoryboard] = useState<StoryboardScene[]>([]);
  const [generatingBoard, setGeneratingBoard] = useState(false);
  const [sceneTexts, setSceneTexts] = useState<Record<number, string>>({});
  const [streamingScene, setStreamingScene] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const guardLlm = (): boolean => {
    const readiness = ensureLlmConfigReady();
    if (!readiness.ok) {
      window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: '融合变体' } }));
      return false;
    }
    return true;
  };

  const toggleNovel = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const collide = async () => {
    if (!guardLlm() || selectedIds.length < 2) return;
    setError(null);
    setColliding(true);
    try {
      const dnaCards = selectedIds
        .map((id) => readyNovels.find((novel) => novel.id === id))
        .filter(Boolean)
        .map((novel) => ({ novelName: novel!.name, ...novel!.dnaCard! }));
      const response = await postWithLlmConfig('/api/py/generate-fusion-directions', {
        dnaCards,
        userCustomPrompt: customPrompt.trim() || undefined,
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response));
      const data = (await response.json()) as { directions: FusionDirection[] };
      setDirections(data.directions || []);
      setStep('directions');
    } catch (err) {
      setError(err instanceof Error ? err.message : '碰撞失败');
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

  const runTweak = async () => {
    if (!guardLlm() || !command.trim() || tweaking) return;
    setError(null);
    setTweaking(true);
    try {
      const response = await postWithLlmConfig('/api/py/tweak-fusion-blocks', {
        ...blocks,
        userInstruction: command.trim(),
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response));
      const data = (await response.json()) as Partial<Record<BlockKey, string>> & { modifiedBlocks: BlockKey[] };
      setBlocks((prev) => {
        const next = { ...prev };
        (data.modifiedBlocks || []).forEach((key) => {
          if (typeof data[key] === 'string') {
            next[key] = data[key] as string;
          }
        });
        return next;
      });
      setCommand('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '调整失败');
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
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response));
      const data = (await response.json()) as { scenes: StoryboardScene[] };
      setStoryboard(data.scenes || []);
      setSceneTexts({});
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成故事板失败');
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
    setSceneTexts((prev) => ({ ...prev, [num]: '' }));
    setStreamingScene(num);
    try {
      await streamSse(
        '/api/py/stream-scene-text',
        {
          selectedDirection: selectedDirection(),
          currentScene: scene,
          precedingTexts,
        },
        {
          onDelta: (text) => setSceneTexts((prev) => ({ ...prev, [num]: (prev[num] || '') + text })),
        }
      );
    } catch (err) {
      setSceneTexts((prev) => ({
        ...prev,
        [num]: `${prev[num] || ''}\n\n[生成失败: ${err instanceof Error ? err.message : err}]`,
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

  // Not enough ready novels
  if (readyNovels.length < 2) {
    return (
      <div className="animate-fade-in flex flex-col items-center justify-center py-20 text-center">
        <h2 className="text-xl font-semibold">需要更多 DNA 资产</h2>
        <p className="mt-2 text-sm text-secondary max-w-md">
          融合工坊需要至少 2 部 DNA 就绪的作品。当前有 {readyNovels.length} 部，还需 {missingReadyCount} 部。
        </p>
        <button
          onClick={() => {
            if (!firstIncompleteNovel) return;
            setWorkshopOpen(false);
            setSelectedNovelId(firstIncompleteNovel.id);
          }}
          className="mt-6 rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-base hover:bg-white/90"
        >
          继续提取 DNA
        </button>
      </div>
    );
  }

  // Step 1: Material Selection
  if (step === 'material') {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="space-y-2">
          <p className="text-xs text-muted">第 1 步</p>
          <h1 className="text-xl font-semibold">选择碰撞作品</h1>
          <p className="text-sm text-secondary">选择至少 2 部作品进行创意融合</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {readyNovels.map((novel) => {
            const selected = selectedIds.includes(novel.id);
            return (
              <button
                key={novel.id}
                onClick={() => toggleNovel(novel.id)}
                className={`rounded-lg border p-4 text-left transition-base ${
                  selected ? 'border-white/30 bg-card' : 'border-subtle hover:border-visible'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{novel.name}</span>
                  {selected && <Check className="h-4 w-4" />}
                </div>
                <p className="mt-2 text-xs text-muted line-clamp-2">{novel.dnaCard?.theme}</p>
              </button>
            );
          })}
        </div>

        <div className="rounded-lg border border-subtle">
          <button
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex w-full items-center justify-between p-4 text-sm transition-base hover:bg-card/50"
          >
            <span>偏航指令（可选）</span>
            <ChevronDown className={`h-4 w-4 text-muted transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
          </button>
          {advancedOpen && (
            <div className="border-t border-subtle p-4">
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                rows={3}
                placeholder="输入自定义的碰撞方向引导..."
                className="w-full rounded-md border border-subtle bg-card p-3 text-sm resize-none focus:outline-none focus:border-visible"
              />
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-900/30 bg-red-950/20 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={collide}
          disabled={selectedIds.length < 2 || colliding}
          className="w-full rounded-md bg-white py-3 text-sm font-medium text-black transition-base hover:bg-white/90 disabled:opacity-50"
        >
          {colliding ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              碰撞计算中...
            </span>
          ) : (
            `开始碰撞 (${selectedIds.length}/2+)`
          )}
        </button>
      </div>
    );
  }

  // Step 2: Direction Selection
  if (step === 'directions') {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setStep('material')}
            className="rounded-md p-2 transition-base hover:bg-card"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="space-y-1">
            <p className="text-xs text-muted">第 2 步</p>
            <h1 className="text-xl font-semibold">选择融合方向</h1>
          </div>
        </div>

        <div className="space-y-4">
          {directions.map((dir, idx) => (
            <button
              key={idx}
              onClick={() => chooseDirection(dir)}
              className="w-full rounded-lg border border-subtle p-5 text-left transition-base hover:border-visible"
            >
              <h3 className="font-medium">{dir.title}</h3>
              <p className="mt-2 text-sm text-secondary">{dir.concept}</p>
              <p className="mt-2 text-xs text-muted">{dir.catalyst}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Step 3: Creator
  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => setStep('directions')}
          className="rounded-md p-2 transition-base hover:bg-card"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="space-y-1">
          <p className="text-xs text-muted">第 3 步</p>
          <h1 className="text-xl font-semibold">{directionTitle}</h1>
        </div>
      </div>

      {/* Blocks */}
      <div className="grid gap-4 sm:grid-cols-2">
        {BLOCKS.map(({ key, label }) => (
          <div key={key} className="rounded-lg border border-subtle p-4">
            <p className="text-xs text-muted uppercase tracking-wide">{label}</p>
            <p className="mt-2 text-sm text-secondary leading-relaxed">{blocks[key]}</p>
          </div>
        ))}
      </div>

      {/* Tweak */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => setCommand(preset.cmd)}
              className="rounded-full border border-subtle px-3 py-1 text-xs transition-base hover:bg-card"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runTweak()}
            placeholder="输入调整指令..."
            className="flex-1 rounded-md border border-subtle bg-card px-4 py-2 text-sm focus:outline-none focus:border-visible"
          />
          <button
            onClick={runTweak}
            disabled={tweaking || !command.trim()}
            className="rounded-md border border-subtle px-4 py-2 transition-base hover:bg-card disabled:opacity-50"
          >
            {tweaking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/30 bg-red-950/20 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Storyboard */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">故事板</h2>
          <button
            onClick={generateStoryboard}
            disabled={generatingBoard}
            className="rounded-md border border-subtle px-3 py-1.5 text-xs transition-base hover:bg-card disabled:opacity-50"
          >
            {generatingBoard ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                生成中...
              </span>
            ) : (
              '生成故事板'
            )}
          </button>
        </div>

        {storyboard.length > 0 && (
          <div className="space-y-4">
            {storyboard.map((scene) => (
              <div key={scene.sceneNumber} className="rounded-lg border border-subtle p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{scene.sceneTitle}</h3>
                  <span className="text-xs text-muted">场景 {scene.sceneNumber}</span>
                </div>
                <p className="mt-2 text-sm text-secondary">{scene.plotOutline}</p>

                {sceneTexts[scene.sceneNumber] ? (
                  <div className="mt-4 space-y-3">
                    <div className="max-h-60 overflow-y-auto rounded-md border border-subtle bg-card p-3 text-sm leading-relaxed">
                      {sceneTexts[scene.sceneNumber]}
                      {streamingScene === scene.sceneNumber && (
                        <span className="inline-block w-1 h-4 bg-white animate-pulse ml-1" />
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => copyScene(scene.sceneNumber)}
                        className="flex items-center gap-1 rounded-md border border-subtle px-2 py-1 text-xs transition-base hover:bg-card"
                      >
                        {copied === scene.sceneNumber ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                        {copied === scene.sceneNumber ? '已复制' : '复制'}
                      </button>
                      <button
                        onClick={() => saveScene(scene)}
                        className="flex items-center gap-1 rounded-md border border-subtle px-2 py-1 text-xs transition-base hover:bg-card"
                      >
                        <Download className="h-3 w-3" />
                        下载
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => generateScene(scene)}
                    disabled={streamingScene !== null}
                    className="mt-4 rounded-md border border-subtle px-3 py-1.5 text-xs transition-base hover:bg-card disabled:opacity-50"
                  >
                    {streamingScene === scene.sceneNumber ? (
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        生成中...
                      </span>
                    ) : (
                      '生成正文'
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
