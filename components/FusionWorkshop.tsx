'use client';

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
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
        { selectedDirection: selectedDirection(), currentScene: scene, precedingTexts },
        { onDelta: (text) => setSceneTexts((prev) => ({ ...prev, [num]: (prev[num] || '') + text })) }
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
      <div className="max-w-xl space-y-4">
        <h2 className="text-lg">融合工坊</h2>
        <p className="text-secondary">
          需要至少 2 部 DNA 就绪的作品。当前 {readyNovels.length} 部，还需 {missingReadyCount} 部。
        </p>
        {firstIncompleteNovel && (
          <button
            onClick={() => {
              setWorkshopOpen(false);
              setSelectedNovelId(firstIncompleteNovel.id);
            }}
            className="text-sm text-secondary hover:text-primary"
          >
            继续提取 DNA →
          </button>
        )}
      </div>
    );
  }

  // Step 1: Material Selection
  if (step === 'material') {
    return (
      <div className="max-w-2xl space-y-6">
        <div>
          <p className="text-xs text-muted">1/3</p>
          <h2 className="text-lg">选择素材</h2>
          <p className="mt-1 text-sm text-secondary">选择 2 部以上作品进行碰撞</p>
        </div>

        <div className="space-y-2">
          {readyNovels.map((novel) => {
            const selected = selectedIds.includes(novel.id);
            return (
              <button
                key={novel.id}
                onClick={() => toggleNovel(novel.id)}
                className={`block w-full border p-3 text-left text-sm ${selected ? 'border-primary' : 'border-default hover:border-secondary'}`}
              >
                <span className={selected ? 'text-primary' : 'text-secondary'}>{novel.name}</span>
                {selected && <span className="ml-2 text-muted">✓</span>}
              </button>
            );
          })}
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted">偏航指令（可选）</p>
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            rows={2}
            placeholder="自定义碰撞方向..."
            className="w-full border bg-transparent p-2 text-sm focus:outline-none"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          onClick={collide}
          disabled={selectedIds.length < 2 || colliding}
          className="text-sm disabled:text-muted disabled:cursor-not-allowed"
        >
          {colliding ? '碰撞中...' : `开始碰撞 (${selectedIds.length})`}
        </button>
      </div>
    );
  }

  // Step 2: Direction Selection
  if (step === 'directions') {
    return (
      <div className="max-w-2xl space-y-6">
        <div className="flex items-center gap-4">
          <button onClick={() => setStep('material')} className="text-secondary hover:text-primary">←</button>
          <div>
            <p className="text-xs text-muted">2/3</p>
            <h2 className="text-lg">选择方向</h2>
          </div>
        </div>

        <div className="space-y-4">
          {directions.map((dir, idx) => (
            <button
              key={idx}
              onClick={() => chooseDirection(dir)}
              className="block w-full border border-default p-4 text-left hover:border-secondary"
            >
              <p className="text-sm">{dir.title}</p>
              <p className="mt-2 text-sm text-secondary">{dir.concept}</p>
              <p className="mt-1 text-xs text-muted">{dir.catalyst}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Step 3: Creator
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <button onClick={() => setStep('directions')} className="text-secondary hover:text-primary">←</button>
        <div>
          <p className="text-xs text-muted">3/3</p>
          <h2 className="text-lg">{directionTitle}</h2>
        </div>
      </div>

      {/* Blocks */}
      <div className="grid gap-4 sm:grid-cols-2">
        {BLOCKS.map(({ key, label }) => (
          <div key={key} className="border border-default p-3">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 text-sm text-secondary leading-relaxed">{blocks[key]}</p>
          </div>
        ))}
      </div>

      {/* Tweak */}
      <div className="flex gap-2">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runTweak()}
          placeholder="调整指令..."
          className="flex-1 border bg-transparent p-2 text-sm focus:outline-none"
        />
        <button
          onClick={runTweak}
          disabled={tweaking || !command.trim()}
          className="px-3 text-sm text-secondary hover:text-primary disabled:text-muted"
        >
          {tweaking ? '...' : '发送'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Storyboard */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm">故事板</span>
          <button
            onClick={generateStoryboard}
            disabled={generatingBoard}
            className="text-sm text-secondary hover:text-primary disabled:text-muted"
          >
            {generatingBoard ? '生成中...' : '生成'}
          </button>
        </div>

        {storyboard.length > 0 && (
          <div className="space-y-4">
            {storyboard.map((scene) => (
              <div key={scene.sceneNumber} className="border border-default p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm">{scene.sceneTitle}</span>
                  <span className="text-xs text-muted">#{scene.sceneNumber}</span>
                </div>
                <p className="mt-2 text-sm text-secondary">{scene.plotOutline}</p>

                {sceneTexts[scene.sceneNumber] ? (
                  <div className="mt-4 space-y-2">
                    <div className="max-h-48 overflow-y-auto border border-default p-3 text-sm text-secondary leading-relaxed whitespace-pre-wrap">
                      {sceneTexts[scene.sceneNumber]}
                      {streamingScene === scene.sceneNumber && <span className="inline-block w-1 h-3 bg-primary animate-pulse ml-0.5" />}
                    </div>
                    <div className="flex gap-4 text-xs">
                      <button onClick={() => copyScene(scene.sceneNumber)} className="text-muted hover:text-secondary">复制</button>
                      <button onClick={() => saveScene(scene)} className="text-muted hover:text-secondary">下载</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => generateScene(scene)}
                    disabled={streamingScene !== null}
                    className="mt-3 text-sm text-secondary hover:text-primary disabled:text-muted"
                  >
                    {streamingScene === scene.sceneNumber ? '生成中...' : '生成正文'}
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
