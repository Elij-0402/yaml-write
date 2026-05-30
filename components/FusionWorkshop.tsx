'use client';

import { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../app/db';
import { ensureLlmConfigReady, postWithLlmConfig, readApiErrorMessage, streamSse } from '../app/llmClient';
import {
  Sparkles, Loader2, Zap, ArrowLeft, Send, Clapperboard, PenTool,
  Copy, Check, Download, Globe, Swords, Palette, Film,
} from 'lucide-react';

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

const BLOCKS: { key: BlockKey; label: string; icon: typeof Globe }[] = [
  { key: 'worldviewBlock', label: '世界观规约', icon: Globe },
  { key: 'protagonistBlock', label: '主角原型', icon: Sparkles },
  { key: 'antagonistBlock', label: '对手原型', icon: Swords },
  { key: 'narrativeTone', label: '叙事色调', icon: Palette },
];

const STATUS_CHAIN = [
  '[01/04] Calculating genre divergence...',
  '[02/04] Simulating structural debate: Magic vs Silicon...',
  '[03/04] Injecting catalyst variables...',
  '[04/04] Shaving AI clichés & polishing fingerprints...',
];

export default function FusionWorkshop() {
  const novels = useLiveQuery(() => db.novels.reverse().toArray(), []) || [];
  const readyNovels = novels.filter((n) => n.analysisStatus === 'done' && n.dnaCard);

  const [step, setStep] = useState<'chamber' | 'directions' | 'creator'>('chamber');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [adversarialRules, setAdversarialRules] = useState('');
  const [colliding, setColliding] = useState(false);
  const [statusIdx, setStatusIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [directions, setDirections] = useState<FusionDirection[]>([]);
  const [blocks, setBlocks] = useState<Record<BlockKey, string>>({
    worldviewBlock: '', protagonistBlock: '', antagonistBlock: '', narrativeTone: '',
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

  // Rotating micro-copy status line while colliding
  useEffect(() => {
    if (!colliding) return;
    const t = setInterval(() => setStatusIdx((i) => (i + 1) % STATUS_CHAIN.length), 1800);
    return () => clearInterval(t);
  }, [colliding]);

  const guardLlm = (): boolean => {
    const readiness = ensureLlmConfigReady();
    if (!readiness.ok) {
      window.dispatchEvent(new Event('open-settings-panel'));
      return false;
    }
    return true;
  };

  const toggleNovel = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const collide = async () => {
    if (!guardLlm() || selectedIds.length === 0) return;
    setError(null);
    setColliding(true);
    setStatusIdx(0);
    try {
      const dnaCards = selectedIds
        .map((id) => readyNovels.find((n) => n.id === id))
        .filter(Boolean)
        .map((n) => ({ novelName: n!.name, ...n!.dnaCard! }));
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

  const chooseDirection = (d: FusionDirection) => {
    setDirectionTitle(d.title);
    setBlocks({
      worldviewBlock: d.worldviewBlock,
      protagonistBlock: d.protagonistBlock,
      antagonistBlock: d.antagonistBlock,
      narrativeTone: d.narrativeTone,
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
      setBlocks((prev) => {
        const next = { ...prev };
        (data.modifiedBlocks || []).forEach((k) => {
          if (typeof data[k] === 'string') { next[k] = data[k] as string; changed.push(k); }
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
    [num - 2, num - 1].forEach((n) => { if (n >= 1 && sceneTexts[n]) precedingTexts[n] = sceneTexts[n]; });
    setSceneTexts((prev) => ({ ...prev, [num]: '' }));
    setStreamingScene(num);
    try {
      await streamSse('/api/py/stream-scene-text', {
        selectedDirection: selectedDirection(),
        currentScene: scene,
        precedingTexts,
        adversarialRules: adversarialRules.trim() || undefined,
      }, {
        onDelta: (t) => setSceneTexts((prev) => ({ ...prev, [num]: (prev[num] || '') + t })),
      });
    } catch (err) {
      setSceneTexts((prev) => ({ ...prev, [num]: (prev[num] || '') + `\n\n[生成出错: ${err instanceof Error ? err.message : err}]` }));
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
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scene.sceneTitle || 'scene'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---------- Render ----------
  if (step === 'chamber') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-6 animate-fade-in max-w-2xl mx-auto w-full">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-zinc-100 mb-1.5">万有引力室</h1>
          <p className="text-xs text-zinc-500">选择 1 本及以上已生成 DNA 的小说，让它们的创作基因激烈碰撞。</p>
        </div>

        {readyNovels.length === 0 ? (
          <div className="linear-card rounded-lg p-6 text-center text-xs text-zinc-400 max-w-md">
            还没有「DNA 就绪」的小说。请先在小说详情页提取至少一本书的创作 DNA。
          </div>
        ) : (
          <div className="w-full grid grid-cols-2 gap-2.5">
            {readyNovels.map((n) => {
              const on = selectedIds.includes(n.id);
              return (
                <button
                  key={n.id}
                  onClick={() => toggleNovel(n.id)}
                  className={`text-left p-3 rounded-lg border transition-linear active-press ${
                    on ? 'border-amber-500/60 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${on ? 'bg-amber-400' : 'bg-zinc-600'}`} />
                    <span className="text-xs font-medium text-zinc-200 truncate">{n.name}</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1.5 line-clamp-2">{n.dnaCard?.theme}</p>
                </button>
              );
            })}
          </div>
        )}

        <div className="w-full flex flex-col gap-2.5">
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            rows={2}
            placeholder="自定义大方向（可选）：例如「往废土生存 + 商战权谋方向碰撞」"
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded text-xs text-zinc-200 p-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500/30 transition-linear resize-none"
          />
          <textarea
            value={adversarialRules}
            onChange={(e) => setAdversarialRules(e.target.value)}
            rows={2}
            placeholder="反套路红队约束（可选）：例如「开启极度冰冷物理逻辑红队审查，严防任何唯心主义修真套路」"
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded text-xs text-zinc-200 p-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500/30 transition-linear resize-none"
          />
        </div>

        {error && <p className="text-[11px] text-orange-400">{error}</p>}

        {colliding ? (
          <div key={statusIdx} className="text-[11px] font-mono text-amber-400/90 animate-fade-in flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            {STATUS_CHAIN[statusIdx]}
          </div>
        ) : (
          <button
            onClick={collide}
            disabled={selectedIds.length === 0}
            className="flex items-center gap-2 text-sm font-medium px-6 py-3 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-zinc-950 transition-linear active-press disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Zap className="w-4 h-4" /> 启动创意碰撞
          </button>
        )}
      </div>
    );
  }

  if (step === 'directions') {
    return (
      <div className="flex-1 flex flex-col gap-4 animate-fade-in">
        <button onClick={() => setStep('chamber')} className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 transition-linear w-fit active-press">
          <ArrowLeft className="w-3.5 h-3.5" /> 返回引力室
        </button>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-1">
          {directions.map((d, i) => (
            <button
              key={i}
              onClick={() => chooseDirection(d)}
              className="text-left linear-card rounded-xl p-5 flex flex-col gap-3 hover:-translate-y-1 hover:border-amber-500/40 transition-all duration-250 active-press"
            >
              <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-500">方向 {i + 1}</span>
              <h3 className="text-sm font-semibold text-zinc-100 leading-snug">{d.title}</h3>
              <p className="text-xs text-zinc-300 leading-relaxed flex-1">{d.concept}</p>
              <div className="pt-3 border-t border-zinc-800">
                <span className="text-[10px] uppercase font-mono tracking-widest text-amber-500/80">质变催化变量</span>
                <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">{d.catalyst}</p>
              </div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400 pt-1">
                <Sparkles className="w-3.5 h-3.5" /> 开启该变体世界
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // step === 'creator'
  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0 animate-fade-in">
      <div className="flex items-center justify-between">
        <button onClick={() => setStep('directions')} className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 transition-linear active-press">
          <ArrowLeft className="w-3.5 h-3.5" /> 重选方向
        </button>
        <h2 className="text-sm font-semibold text-zinc-200 truncate">{directionTitle}</h2>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-4 min-h-0">
        {/* 4 setting blocks */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {BLOCKS.map(({ key, label, icon: Icon }) => (
            <div
              key={key}
              className={`linear-card rounded-lg p-4 transition-all duration-250 ${pulse.has(key) ? 'pulse-cyan border-cyan-400/50' : ''}`}
            >
              <div className="flex items-center gap-2 mb-2 text-cyan-400/80">
                <Icon className="w-3.5 h-3.5" />
                <span className="text-[10px] uppercase font-mono tracking-widest">{label}</span>
              </div>
              <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{blocks[key]}</p>
            </div>
          ))}
        </div>

        {/* Storyboard */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-500">故事板分镜</span>
          <button
            onClick={generateStoryboard}
            disabled={generatingBoard}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded border border-zinc-700 hover:bg-zinc-800/60 text-zinc-200 transition-linear active-press disabled:opacity-50"
          >
            {generatingBoard ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clapperboard className="w-3.5 h-3.5" />}
            {storyboard.length ? '重新生成故事板' : '生成故事板'}
          </button>
        </div>

        {storyboard.map((scene) => (
          <div key={scene.sceneNumber} className="linear-card rounded-lg p-4 flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-zinc-500">Scene {scene.sceneNumber}</span>
                <h4 className="text-sm font-semibold text-zinc-100">{scene.sceneTitle}</h4>
              </div>
              <button
                onClick={() => generateScene(scene)}
                disabled={streamingScene !== null}
                className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded bg-amber-500/90 hover:bg-amber-500 text-zinc-950 transition-linear active-press disabled:opacity-50"
              >
                {streamingScene === scene.sceneNumber ? <Loader2 className="w-3 h-3 animate-spin" /> : <PenTool className="w-3 h-3" />}
                动笔生成
              </button>
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">{scene.plotOutline}</p>
            <div className="flex gap-4 text-[11px] text-zinc-500">
              <span>张力：{scene.tensionLevel}</span>
              <span className="flex items-center gap-1"><Film className="w-3 h-3" />{scene.visualCues}</span>
            </div>

            {sceneTexts[scene.sceneNumber] !== undefined && (
              <div className="mt-1 border-t border-zinc-800 pt-3">
                <div className="flex items-center justify-end gap-2 mb-2">
                  <button onClick={() => copyScene(scene.sceneNumber)} className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-100 active-press transition-linear">
                    {copied === scene.sceneNumber ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} 复制
                  </button>
                  <button onClick={() => saveScene(scene)} className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-100 active-press transition-linear">
                    <Download className="w-3 h-3" /> 保存
                  </button>
                </div>
                <p className="text-[15px] text-zinc-200 leading-loose whitespace-pre-wrap">
                  {sceneTexts[scene.sceneNumber]}
                  {streamingScene === scene.sceneNumber && <span className="inline-block w-1.5 h-4 bg-amber-400 ml-0.5 animate-pulse align-middle" />}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>

      {error && <p className="text-[11px] text-orange-400">{error}</p>}

      {/* Command bar */}
      <div className="shrink-0 flex items-center gap-2 linear-card rounded-lg px-3 py-2">
        <Sparkles className="w-4 h-4 text-amber-500/70 shrink-0" />
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runTweak(); }}
          placeholder="输入一句话微调设定，如「让主角变成瞎子，用引力当日记本」"
          className="flex-1 bg-transparent text-sm text-zinc-200 focus:outline-none placeholder:text-zinc-600"
        />
        <button onClick={runTweak} disabled={tweaking || !command.trim()} className="text-amber-400 hover:text-amber-300 active-press disabled:opacity-40 transition-linear">
          {tweaking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
