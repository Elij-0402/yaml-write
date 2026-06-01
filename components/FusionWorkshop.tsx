'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../app/db';
import { ensureLlmConfigReady, postWithLlmConfig, readApiErrorMessage, streamSse } from '../app/llmClient';
import { useAppStore } from '../app/store';

const interpolateColor = (color1: string, color2: string, factor: number) => {
  const f = typeof factor === 'number' && !isNaN(factor) ? factor : 0.5;
  
  const parseHex = (hex: string, start: number, end: number) => {
    if (!hex || hex.length < end) return 0;
    const val = parseInt(hex.substring(start, end), 16);
    return isNaN(val) ? 0 : val;
  };

  const r1 = parseHex(color1, 1, 3);
  const g1 = parseHex(color1, 3, 5);
  const b1 = parseHex(color1, 5, 7);

  const r2 = parseHex(color2, 1, 3);
  const g2 = parseHex(color2, 3, 5);
  const b2 = parseHex(color2, 5, 7);

  const r = Math.round(r1 + f * (r2 - r1));
  const g = Math.round(g1 + f * (g2 - g1));
  const b = Math.round(b1 + f * (b2 - b1));

  return `rgb(${r}, ${g}, ${b})`;
};

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
const COLLISION_PARTICLES = 16;
const ANTI_SLOP_PHRASES = [
  '命运的齿轮',
  '那一刻',
  '逆天改命',
  '眼神变得坚定',
  '嘴角勾起一抹弧度',
  '仿佛整个世界都安静了',
  '空气仿佛凝固',
  '心中一紧',
  '缓缓睁开眼',
  '不知为何',
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Frontend filter is only a fallback guardrail; source-of-truth constraints remain in backend prompts.
const applyAntiSlopFallback = (text: string): string => {
  return ANTI_SLOP_PHRASES.reduce((acc, phrase, idx) => {
    const reg = new RegExp(escapeRegExp(phrase), 'g');
    return acc.replace(reg, `[已过滤陈词滥调#${idx + 1}]`);
  }, text);
};

const STORYBOARD_BLOCK_RE =
  /\[SCENE-(\d+)\]\s*title:\s*([\s\S]*?)\s*plot:\s*([\s\S]*?)\s*tension:\s*([\s\S]*?)\s*visual:\s*([\s\S]*?)\s*\[\/SCENE-\1\]/gi;

const parseStoryboardStreamText = (raw: string): StoryboardScene[] => {
  const scenes: StoryboardScene[] = [];
  STORYBOARD_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null = STORYBOARD_BLOCK_RE.exec(raw);
  while (match) {
    scenes.push({
      sceneNumber: Number(match[1] || scenes.length + 1),
      sceneTitle: applyAntiSlopFallback(match[2]?.trim() || `分镜 ${match[1]}`),
      plotOutline: applyAntiSlopFallback(match[3]?.trim() || ''),
      tensionLevel: applyAntiSlopFallback(match[4]?.trim() || ''),
      visualCues: applyAntiSlopFallback(match[5]?.trim() || ''),
    });
    match = STORYBOARD_BLOCK_RE.exec(raw);
  }
  return scenes
    .filter((scene) => scene.sceneTitle && scene.plotOutline)
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
};

const normalizeScenesPayload = (value: unknown): StoryboardScene[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const scene = item as Record<string, unknown>;
      const sceneNumber = Number(scene.sceneNumber);
      const sceneTitle = typeof scene.sceneTitle === 'string' ? scene.sceneTitle : '';
      const plotOutline = typeof scene.plotOutline === 'string' ? scene.plotOutline : '';
      const tensionLevel = typeof scene.tensionLevel === 'string' ? scene.tensionLevel : '';
      const visualCues = typeof scene.visualCues === 'string' ? scene.visualCues : '';
      if (!Number.isFinite(sceneNumber) || !sceneTitle || !plotOutline) return null;
      return {
        sceneNumber,
        sceneTitle: applyAntiSlopFallback(sceneTitle),
        plotOutline: applyAntiSlopFallback(plotOutline),
        tensionLevel: applyAntiSlopFallback(tensionLevel),
        visualCues: applyAntiSlopFallback(visualCues),
      };
    })
    .filter((scene): scene is StoryboardScene => Boolean(scene))
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
};

export default function FusionWorkshop() {
  const { setSelectedNovelId, setWorkshopOpen, fusionBias, setFusionBias } = useAppStore((state) => ({
    setSelectedNovelId: state.setSelectedNovelId,
    setWorkshopOpen: state.setWorkshopOpen,
    fusionBias: state.fusionBias,
    setFusionBias: state.setFusionBias,
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
  const [storyboardStreamText, setStoryboardStreamText] = useState('');
  const [generatingBoard, setGeneratingBoard] = useState(false);
  const [sceneTexts, setSceneTexts] = useState<Record<number, string>>({});
  const [streamingScene, setStreamingScene] = useState<number | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [collisionPhase, setCollisionPhase] = useState<'idle' | 'igniting' | 'charging'>('idle');
  const [showParticles, setShowParticles] = useState(false);
  const [directionsRevealNonce, setDirectionsRevealNonce] = useState(0);

  const collisionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collisionResolveRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  const clearCollisionTimer = () => {
    if (collisionTimerRef.current) {
      clearTimeout(collisionTimerRef.current);
      collisionTimerRef.current = null;
    }
    if (collisionResolveRef.current) {
      const resolve = collisionResolveRef.current;
      collisionResolveRef.current = null;
      resolve();
    }
  };

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearCollisionTimer();
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
    if (!guardLlm() || selectedIds.length < 2 || colliding) return;
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cinematicCollision = selectedIds.length === 2;
    const collisionDurationMs = cinematicCollision ? (reduceMotion ? 100 : 1500) : 100;

    setError(null);
    setColliding(true);
    clearCollisionTimer();
    setCollisionPhase(cinematicCollision ? 'igniting' : 'idle');
    setShowParticles(cinematicCollision && !reduceMotion);

    try {
      const animationDone = new Promise<void>((resolve) => {
        collisionResolveRef.current = resolve;
        collisionTimerRef.current = setTimeout(() => {
          collisionTimerRef.current = null;
          const done = collisionResolveRef.current;
          collisionResolveRef.current = null;
          if (mountedRef.current) {
            setShowParticles(false);
            setCollisionPhase(cinematicCollision && !reduceMotion ? 'charging' : 'idle');
          }
          done?.();
        }, collisionDurationMs);
      });
      const dnaCards = selectedIds
        .map((id) => readyNovels.find((novel) => novel.id === id))
        .filter(Boolean)
        .map((novel) => ({ novelName: novel!.name, ...novel!.dnaCard! }));
      const response = await postWithLlmConfig('/api/py/generate-fusion-directions', {
        dnaCards,
        userCustomPrompt: customPrompt.trim() || undefined,
        fusionBias: selectedIds.length === 2 ? fusionBias : 0.5,
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response));
      const data = (await response.json()) as { directions: FusionDirection[] };
      await animationDone;
      if (!mountedRef.current) return;

      setDirections(data.directions || []);
      setDirectionsRevealNonce((prev) => prev + 1);
      setStep('directions');
      setCollisionPhase('idle');
      setShowParticles(false);
    } catch (err) {
      clearCollisionTimer();
      if (!mountedRef.current) return;
      setCollisionPhase('idle');
      setShowParticles(false);
      setError(err instanceof Error ? err.message : '碰撞失败');
    } finally {
      if (mountedRef.current) {
        setColliding(false);
      }
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
    setStoryboardStreamText('');
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
    if (!guardLlm() || generatingBoard || streamingScene !== null) return;
    setError(null);
    setGeneratingBoard(true);
    setStoryboard([]);
    setSceneTexts({});
    setStoryboardStreamText('');
    let streamedText = '';
    let hasParsedScenes = false;
    try {
      await streamSse(
        '/api/py/stream-storyboard',
        { selectedDirection: selectedDirection(), sceneCount: 3 },
        {
          onDelta: (text) => {
            streamedText += text;
            setStoryboardStreamText((prev) => prev + applyAntiSlopFallback(text));
          },
          onDone: (payload) => {
            const fromDone = normalizeScenesPayload(payload.scenes);
            const fromText = parseStoryboardStreamText(streamedText);
            const finalScenes = fromDone.length > 0 ? fromDone : fromText;
            if (finalScenes.length > 0) {
              hasParsedScenes = true;
              setStoryboard(finalScenes);
            }
          },
        }
      );
      if (!hasParsedScenes && parseStoryboardStreamText(streamedText).length === 0) {
        setError('故事板流式完成，但未能解析分镜结构，请重试。');
      }
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
        {
          onDelta: (text) =>
            setSceneTexts((prev) => ({
              ...prev,
              [num]: (prev[num] || '') + applyAntiSlopFallback(text),
            })),
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
    const selectedNovels = selectedIds
      .map((id) => readyNovels.find((novel) => novel.id === id))
      .filter(Boolean);
    const showOrbit = selectedIds.length === 2 && selectedNovels.length === 2;

    return (
      <div className="max-w-2xl space-y-6">
        <style>{`
          @keyframes orbit-rotate-anim {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          @keyframes orbit-ignite-anim {
            0% { transform: rotate(0deg) scale(1); }
            60% { transform: rotate(540deg) scale(0.92); }
            100% { transform: rotate(960deg) scale(0.82); }
          }
          @keyframes orbit-ring-collapse-anim {
            0% { transform: scale(1); opacity: 0.4; }
            70% { transform: scale(0.7); opacity: 0.68; }
            100% { transform: scale(0.5); opacity: 0; }
          }
          @keyframes planet-a-collision-anim {
            0% { transform: translateX(-50%) translateX(0) scale(1); opacity: 1; }
            100% { transform: translateX(-50%) translateX(80px) scale(0.35); opacity: 0; }
          }
          @keyframes planet-b-collision-anim {
            0% { transform: translateX(-50%) translateX(0) scale(1); opacity: 1; }
            100% { transform: translateX(-50%) translateX(-80px) scale(0.35); opacity: 0; }
          }
          @keyframes core-charge-anim {
            0%, 100% { opacity: 0.95; transform: scale(1); }
            50% { opacity: 1; transform: scale(1.04); }
          }
          @keyframes gravity-wave-particle-anim {
            0% { opacity: 1; transform: translateX(0) scale(1); }
            100% { opacity: 0; transform: translateX(78px) scale(0.2); }
          }
          .animate-orbit-rotate {
            animation: orbit-rotate-anim 12s linear infinite;
          }
          .animate-orbit-ignite {
            animation: orbit-ignite-anim 1.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          }
          .animate-orbit-ring-collapse {
            animation: orbit-ring-collapse-anim 1.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          }
          .animate-planet-a-collision {
            animation: planet-a-collision-anim 1.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          }
          .animate-planet-b-collision {
            animation: planet-b-collision-anim 1.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          }
          .animate-core-charge {
            animation: core-charge-anim 1.2s ease-in-out infinite;
          }
          .gravity-wave-particle {
            will-change: transform, opacity;
            animation: gravity-wave-particle-anim 1.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          }
          .will-change-transform {
            will-change: transform;
          }
          @media (prefers-reduced-motion: reduce) {
            .animate-orbit-rotate {
              animation: none !important;
            }
            .animate-orbit-ignite,
            .animate-orbit-ring-collapse,
            .animate-planet-a-collision,
            .animate-planet-b-collision,
            .animate-core-charge,
            .gravity-wave-particle {
              animation: none !important;
            }
            .gravity-wave-layer {
              opacity: 0 !important;
            }
          }
          .glowing-slider {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 4px;
            border-radius: 9999px;
            outline: none;
          }
          .glowing-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: #ffffff;
            box-shadow: 0 0 8px rgba(6, 182, 212, 0.9);
            cursor: pointer;
            transition: transform 0.1s ease;
          }
          .glowing-slider::-webkit-slider-thumb:hover {
            transform: scale(1.2);
          }
        `}</style>

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

        {showOrbit && (
          <div className="border border-[#1b1e36] bg-[#0c0e20]/60 p-6 rounded-lg backdrop-blur-md space-y-6">

            <div className="text-center">
              <span className="text-xs font-semibold tracking-wider text-[#5e6ad2] uppercase">引力公轨视图 (Gravity Orbit)</span>
            </div>

            {/* Celestial Orbit View */}
            <div className="relative w-64 h-64 mx-auto my-4 border border-[#1b1e36]/30 rounded-full [perspective:800px] flex items-center justify-center overflow-hidden bg-black/40">
              {/* Dashed Orbit Ring */}
              <div 
                className={`absolute inset-4 border border-dashed rounded-full will-change-transform ${collisionPhase === 'igniting' ? 'animate-orbit-ring-collapse' : 'animate-orbit-rotate'}`}
                style={{
                  borderColor: interpolateColor('#06b6d4', '#5e6ad2', fusionBias),
                  boxShadow: `0 0 10px ${interpolateColor('#06b6d4', '#5e6ad2', fusionBias)}`,
                  opacity: 0.4
                }}
              />

              {/* Center Black Hole Collision Core */}
              <div 
                role="button"
                aria-label="触发星体碰撞"
                aria-disabled={selectedIds.length < 2 || colliding}
                tabIndex={selectedIds.length < 2 || colliding ? -1 : 0}
                onClick={() => {
                  if (!colliding) {
                    void collide();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (!colliding) {
                      void collide();
                    }
                  }
                }}
                className={`relative z-10 w-10 h-10 rounded-full bg-black border border-[#1b1e36] flex items-center justify-center transition-all duration-300 ${selectedIds.length < 2 || colliding ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'} ${collisionPhase === 'charging' ? 'animate-core-charge' : ''}`}
                style={{
                  boxShadow: `0 0 20px ${interpolateColor('#06b6d4', '#5e6ad2', fusionBias)}`
                }}
              >
                <span className="text-xs animate-pulse">💥</span>
              </div>

              {showParticles && (
                <div className="gravity-wave-layer pointer-events-none absolute inset-0 z-20">
                  {Array.from({ length: COLLISION_PARTICLES }).map((_, index) => {
                    const angle = (360 / COLLISION_PARTICLES) * index;
                    const delay = (index % 4) * 0.04;
                    return (
                      <div
                        key={`particle-${index}`}
                        className="absolute left-1/2 top-1/2 will-change-transform"
                        style={{ transform: `translate(-50%, -50%) rotate(${angle}deg)` }}
                      >
                        <svg width="4" height="4" viewBox="0 0 4 4" className="overflow-visible">
                          <circle
                            cx="2"
                            cy="2"
                            r={index % 3 === 0 ? 2 : 1.5}
                            className="gravity-wave-particle"
                            style={{
                              animationDelay: `${delay}s`,
                              fill: index % 2 === 0 ? '#e2e8f0' : interpolateColor('#06b6d4', '#5e6ad2', fusionBias)
                            }}
                          />
                        </svg>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Orbit Rotating Planets Container (GPU offloaded rotation) */}
              <div className={`absolute inset-0 flex items-center justify-center will-change-transform ${collisionPhase === 'igniting' ? 'animate-orbit-ignite' : 'animate-orbit-rotate'}`}>
                {/* Planet A (Cyan #06b6d4) at opposite end (-80px) */}
                <div 
                  className={`absolute rounded-full will-change-transform transition-all duration-300 shadow-[0_0_15px_#06b6d4] ${collisionPhase === 'igniting' ? 'animate-planet-a-collision' : ''}`}
                  style={{
                    left: 'calc(50% - 80px)',
                    transform: 'translateX(-50%)',
                    width: `${16 + (1 - fusionBias) * 16}px`,
                    height: `${16 + (1 - fusionBias) * 16}px`,
                    backgroundColor: '#06b6d4',
                    opacity: 1 - fusionBias + 0.15,
                    boxShadow: `0 0 ${10 + (1 - fusionBias) * 20}px #06b6d4`
                  }}
                />

                {/* Planet B (Blue #5e6ad2) at end (+80px) */}
                <div 
                  className={`absolute rounded-full will-change-transform transition-all duration-300 shadow-[0_0_15px_#5e6ad2] ${collisionPhase === 'igniting' ? 'animate-planet-b-collision' : ''}`}
                  style={{
                    left: 'calc(50% + 80px)',
                    transform: 'translateX(-50%)',
                    width: `${16 + fusionBias * 16}px`,
                    height: `${16 + fusionBias * 16}px`,
                    backgroundColor: '#5e6ad2',
                    opacity: fusionBias + 0.15,
                    boxShadow: `0 0 ${10 + fusionBias * 20}px #5e6ad2`
                  }}
                />
              </div>
            </div>

            {collisionPhase === 'charging' && (
              <p className="text-center text-xs text-[#e2e8f0]">星轨能量充能中...</p>
            )}

            {/* Sliders and Labels */}
            <div className="space-y-3">
              <div className="flex justify-between text-xs text-muted">
                <span className="text-[#06b6d4] font-medium">偏向 《{selectedNovels[0]?.name}》</span>
                <span className="text-[#5e6ad2] font-medium">偏向 《{selectedNovels[1]?.name}》</span>
              </div>

              <input 
                type="range"
                min="0.01"
                max="0.99"
                step="0.01"
                value={fusionBias ?? 0.5}
                onChange={(e) => setFusionBias(parseFloat(e.target.value))}
                className="glowing-slider bg-[#1b1e36] cursor-pointer"
              />

              <div className="text-center font-mono text-xs tracking-wide text-secondary leading-relaxed bg-[#05060f]/60 p-2.5 rounded border border-[#1b1e36]/40">
                《{selectedNovels[0]?.name}》: <span className="text-[#06b6d4] font-semibold">{Math.round((1 - fusionBias) * 100)}%</span> 
                <span className="mx-2 text-muted">|</span> 
                《{selectedNovels[1]?.name}》: <span className="text-[#5e6ad2] font-semibold">{Math.round(fusionBias * 100)}%</span>
              </div>
            </div>
          </div>
        )}

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
          {colliding ? '碰撞中...' : `触发星体碰撞 💥 (${selectedIds.length})`}
        </button>
      </div>
    );
  }

  // Step 2: Direction Selection
  if (step === 'directions') {
    return (
      <div className="max-w-2xl space-y-6">
        <style>{`
          @keyframes direction-card-reveal-anim {
            0% { opacity: 0; transform: translateY(8px) scale(0.99); }
            100% { opacity: 1; transform: translateY(0) scale(1); }
          }
          .direction-card-reveal {
            opacity: 0;
            animation: direction-card-reveal-anim 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
            will-change: transform, opacity;
          }
          @media (prefers-reduced-motion: reduce) {
            .direction-card-reveal {
              animation-duration: 100ms !important;
              animation-timing-function: ease-out !important;
            }
          }
        `}</style>
        <div className="flex items-center gap-4">
          <button onClick={() => setStep('material')} className="text-secondary hover:text-primary">←</button>
          <div>
            <p className="text-xs text-muted">2/3</p>
            <h2 className="text-lg">选择方向</h2>
          </div>
        </div>

        <div key={`directions-${directionsRevealNonce}`} className="space-y-4">
          {directions.map((dir, idx) => (
            <button
              key={idx}
              onClick={() => chooseDirection(dir)}
              className="direction-card-reveal block w-full border border-[#1b1e36] bg-[#0c0e20] p-4 text-left text-white hover:border-[#e2e8f0]/70"
              style={{
                animationDelay: `${idx * 90}ms`,
                boxShadow: 'inset 0 0 0 1px rgba(226,232,240,0.35), 0 10px 26px rgba(6,8,20,0.45)',
              }}
            >
              <p className="text-sm">{dir.title}</p>
              <p className="mt-2 text-sm text-[#e2e8f0]">{dir.concept}</p>
              <p className="mt-1 text-xs text-[#8a8f98]">{dir.catalyst}</p>
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

      <p className="sr-only" aria-live="polite">
        {generatingBoard
          ? '故事板生成中'
          : streamingScene !== null
            ? `正在流式生成第 ${streamingScene} 分镜正文`
            : error
              ? `发生错误：${error}`
              : '创作流程就绪'}
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Storyboard */}
      <div className="space-y-4">
        <style>{`
          .storyboard-stream-panel {
            transition: opacity 100ms ease-out;
          }
        `}</style>
        <div className="flex items-center justify-between">
          <span className="text-sm">故事板</span>
          <button
            onClick={generateStoryboard}
            disabled={generatingBoard || streamingScene !== null}
            className="text-sm text-secondary hover:text-primary disabled:text-muted"
          >
            {generatingBoard ? '流式生成中...' : '生成故事板'}
          </button>
        </div>

        {(generatingBoard || storyboardStreamText) && (
          <div
            aria-live="polite"
            className={`storyboard-stream-panel border border-default p-3 text-sm text-secondary leading-relaxed whitespace-pre-wrap ${
              prefersReducedMotion ? 'opacity-95' : 'opacity-100'
            }`}
          >
            {storyboardStreamText || '正在构建故事板流...'}
            {generatingBoard && !prefersReducedMotion && (
              <span className="inline-block w-1 h-3 bg-primary animate-pulse ml-0.5" />
            )}
          </div>
        )}

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
                      {streamingScene === scene.sceneNumber && (
                        <span className={`inline-block w-1 h-3 bg-primary ml-0.5 ${prefersReducedMotion ? 'opacity-80' : 'animate-pulse'}`} />
                      )}
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
