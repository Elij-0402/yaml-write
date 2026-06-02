'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type FusionSession } from '../app/db';
import { RateLimitSignal, withRateLimitRetry } from '../app/dnaEngine';
import { StreamSseError, ensureLlmConfigReady, postWithLlmConfig, readApiErrorMessage, streamSse } from '../app/llmClient';
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
type SceneResumeStatus = 'idle' | 'failed-resumable' | 'resuming' | 'done';

const BLOCKS: { key: BlockKey; label: string }[] = [
  { key: 'worldviewBlock', label: '世界观' },
  { key: 'protagonistBlock', label: '主角' },
  { key: 'antagonistBlock', label: '对手' },
  { key: 'narrativeTone', label: '叙事' },
];
const isBlockKey = (value: string): value is BlockKey => BLOCKS.some((block) => block.key === value);
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
  const { setSelectedNovelId, setWorkshopOpen, fusionBias, setFusionBias, rateLimited } = useAppStore((state) => ({
    setSelectedNovelId: state.setSelectedNovelId,
    setWorkshopOpen: state.setWorkshopOpen,
    fusionBias: state.fusionBias,
    setFusionBias: state.setFusionBias,
    rateLimited: state.rateLimited,
  }));
  const novels = useLiveQuery(() => db.novels.reverse().toArray(), []) || [];
  const readyNovels = novels.filter((novel) => novel.analysisStatus === 'done' && novel.dnaCard);
  const missingReadyCount = Math.max(0, 1 - readyNovels.length);
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
  const [tweakingTarget, setTweakingTarget] = useState<BlockKey | null>(null);
  const [tweakTarget, setTweakTarget] = useState<BlockKey>('worldviewBlock');
  const [storyboard, setStoryboard] = useState<StoryboardScene[]>([]);
  const [storyboardStreamText, setStoryboardStreamText] = useState('');
  const [generatingBoard, setGeneratingBoard] = useState(false);
  const [sceneTexts, setSceneTexts] = useState<Record<number, string>>({});
  const [streamingScene, setStreamingScene] = useState<number | null>(null);
  const [sceneResumeStatus, setSceneResumeStatus] = useState<Record<number, SceneResumeStatus>>({});
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [collisionPhase, setCollisionPhase] = useState<'idle' | 'igniting' | 'charging'>('idle');
  const [showParticles, setShowParticles] = useState(false);
  const [directionsRevealNonce, setDirectionsRevealNonce] = useState(0);
  const [adversarialRules, setAdversarialRules] = useState('');
  const [sceneCount, setSceneCount] = useState(3);
  const [copiedScene, setCopiedScene] = useState<number | null>(null);

  const collisionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collisionResolveRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const streamAbortRef = useRef<AbortController | null>(null);
  const hydratedRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // 工坊会话持久化：进入时从 IndexedDB 恢复上次的方向 / 积木 / 故事板 / 正文，刷新或切侧栏不再蒸发。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await db.fusionSessions.get('current');
      if (!cancelled && saved) {
        setSelectedIds(saved.selectedIds || []);
        setCustomPrompt(saved.customPrompt || '');
        setAdversarialRules(saved.adversarialRules || '');
        setStep(saved.step || 'material');
        setDirections(saved.directions || []);
        setBlocks(
          saved.blocks || { worldviewBlock: '', protagonistBlock: '', antagonistBlock: '', narrativeTone: '' }
        );
        setDirectionTitle(saved.directionTitle || '');
        setSceneCount(saved.sceneCount || 3);
        setStoryboard(saved.storyboard || []);
        setSceneTexts(saved.sceneTexts || {});
        setSceneResumeStatus((saved.sceneResumeStatus as Record<number, SceneResumeStatus>) || {});
      }
      if (!cancelled) hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 仅在空闲时刻落盘（流式 / 碰撞 / 调整进行中跳过，避免逐 token 写盘）；一幕流式收尾归 idle 时即落盘。
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (streamingScene !== null || generatingBoard || colliding || tweaking) return;
    const session: FusionSession = {
      id: 'current',
      selectedIds,
      customPrompt,
      adversarialRules,
      step,
      directions,
      blocks,
      directionTitle,
      sceneCount,
      storyboard,
      sceneTexts,
      sceneResumeStatus,
      updatedAt: Date.now(),
    };
    void db.fusionSessions.put(session);
  }, [
    step,
    selectedIds,
    customPrompt,
    adversarialRules,
    directions,
    blocks,
    directionTitle,
    sceneCount,
    storyboard,
    sceneTexts,
    sceneResumeStatus,
    streamingScene,
    generatingBoard,
    colliding,
    tweaking,
  ]);

  // 生成进行中（未落盘窗口）离开页面前提示，避免流式正文丢失。
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (streamingScene !== null || generatingBoard || colliding) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [streamingScene, generatingBoard, colliding]);

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
    if (!guardLlm() || selectedIds.length < 1 || colliding) return;
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
      const collideAbort = new AbortController();
      const data = await withRateLimitRetry(
        async () => {
          const response = await postWithLlmConfig(
            '/api/py/generate-fusion-directions',
            {
              dnaCards,
              userCustomPrompt: customPrompt.trim() || undefined,
              adversarialRules: adversarialRules.trim() || undefined,
              fusionBias: selectedIds.length === 2 ? fusionBias : 0.5,
            },
            { signal: collideAbort.signal }
          );
          if (response.status === 429) throw new RateLimitSignal();
          if (!response.ok) throw new Error(await readApiErrorMessage(response));
          return (await response.json()) as { directions: FusionDirection[] };
        },
        { signal: collideAbort.signal }
      );
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
    if (
      Object.keys(sceneTexts).length > 0 &&
      !window.confirm('切换方向会清空当前已生成的故事板与分镜正文，确定切换？')
    ) {
      return;
    }
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
    setSceneResumeStatus({});
    setTweakTarget('worldviewBlock');
    setStep('creator');
  };

  const runTweak = async () => {
    if (!guardLlm() || !command.trim() || tweaking) return;
    const snapshot = { ...blocks };
    setError(null);
    setTweaking(true);
    setTweakingTarget(tweakTarget);
    try {
      const tweakAbort = new AbortController();
      const data = await withRateLimitRetry(
        async () => {
          const response = await postWithLlmConfig(
            '/api/py/tweak-fusion-blocks',
            {
              ...blocks,
              targetBlock: tweakTarget,
              userInstruction: command.trim(),
              adversarialRules: adversarialRules.trim() || undefined,
            },
            { signal: tweakAbort.signal }
          );
          if (response.status === 429) throw new RateLimitSignal();
          if (!response.ok) throw new Error(await readApiErrorMessage(response));
          return (await response.json()) as Partial<Record<BlockKey, string>> & { modifiedBlocks: BlockKey[] };
        },
        { signal: tweakAbort.signal }
      );
      const reported = (data.modifiedBlocks || []).filter((key): key is BlockKey => isBlockKey(key));
      const applied = reported.filter((key) => key === tweakTarget && typeof data[key] === 'string');
      if (applied.length === 0) {
        // 模型判断该指令未改动目标卡（或只动了非目标卡）：保留指令文本，给出可操作反馈而非静默吞掉。
        setError('该指令未改动当前微调目标卡，换个说法或先切换微调目标后再发送。');
        return;
      }
      setBlocks((prev) => {
        const next = { ...prev };
        applied.forEach((key) => {
          next[key] = data[key] as string;
        });
        return next;
      });
      setCommand('');
    } catch (err) {
      setBlocks(snapshot);
      setError(err instanceof Error ? err.message : '调整失败');
    } finally {
      setTweaking(false);
      setTweakingTarget(null);
    }
  };

  const selectedDirection = () => ({ title: directionTitle, ...blocks });

  const generateStoryboard = async () => {
    if (!guardLlm() || generatingBoard || streamingScene !== null) return;
    setError(null);
    setGeneratingBoard(true);
    setStoryboard([]);
    setSceneTexts({});
    setSceneResumeStatus({});
    setStoryboardStreamText('');
    let streamedText = '';
    let hasParsedScenes = false;
    const ac = new AbortController();
    streamAbortRef.current = ac;
    try {
      await streamSse(
        '/api/py/stream-storyboard',
        {
          selectedDirection: selectedDirection(),
          sceneCount,
          adversarialRules: adversarialRules.trim() || undefined,
        },
        {
          signal: ac.signal,
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
      if (ac.signal.aborted) {
        // 用户主动停止：保留已流式片段（可解析则填入故事板），不报错。
        const partial = parseStoryboardStreamText(streamedText);
        if (partial.length > 0) setStoryboard(partial);
      } else {
        setError(err instanceof Error ? err.message : '生成故事板失败');
      }
    } finally {
      setGeneratingBoard(false);
      streamAbortRef.current = null;
    }
  };

  const generateScene = async (scene: StoryboardScene, mode: 'fresh' | 'resume' = 'fresh') => {
    if (!guardLlm() || streamingScene !== null) return;
    setError(null);
    const num = scene.sceneNumber;
    const existingDraft = sceneTexts[num] || '';
    let receivedSceneText = mode === 'resume' ? existingDraft : '';
    const precedingTexts: Record<number, string> = {};
    [num - 2, num - 1].forEach((n) => {
      if (n >= 1 && sceneTexts[n]) precedingTexts[n] = sceneTexts[n];
    });
    setSceneResumeStatus((prev) => ({ ...prev, [num]: mode === 'resume' ? 'resuming' : 'idle' }));
    if (mode === 'fresh') {
      setSceneTexts((prev) => ({ ...prev, [num]: '' }));
    }
    setStreamingScene(num);
    const ac = new AbortController();
    streamAbortRef.current = ac;
    try {
      await streamSse(
        '/api/py/stream-scene-text',
        {
          selectedDirection: selectedDirection(),
          currentScene: scene,
          precedingTexts,
          // 续写仅传 currentDraft（后端 build_scene_user_prompt 以它为准），去掉与之重复的 resumeFromText。
          currentDraft: mode === 'resume' ? existingDraft : undefined,
          adversarialRules: adversarialRules.trim() || undefined,
        },
        {
          signal: ac.signal,
          onDelta: (text) => {
            const sanitized = applyAntiSlopFallback(text);
            receivedSceneText += sanitized;
            setSceneTexts((prev) => ({
              ...prev,
              [num]: (prev[num] || '') + sanitized,
            }));
          },
        }
      );
      setSceneResumeStatus((prev) => ({ ...prev, [num]: 'done' }));
    } catch (err) {
      const aborted = ac.signal.aborted;
      const reason = err instanceof StreamSseError ? err.code : aborted ? 'aborted' : 'unknown_stream_error';
      const message = err instanceof Error ? err.message : String(err);
      const hasText = receivedSceneText.trim().length > 0 || existingDraft.trim().length > 0;
      const resumable = aborted || (err instanceof StreamSseError && err.resumable) || hasText;
      if (resumable) {
        setSceneResumeStatus((prev) => ({ ...prev, [num]: 'failed-resumable' }));
        setError(
          aborted
            ? `第 ${num} 分镜已停止，可点击「继续接写」续写。`
            : `第 ${num} 分镜中断（${reason}）：${message}，可继续接写。`
        );
      } else {
        setSceneResumeStatus((prev) => ({ ...prev, [num]: 'idle' }));
        setSceneTexts((prev) => ({
          ...prev,
          [num]: `${prev[num] || ''}\n\n[生成失败: ${message}]`,
        }));
      }
    } finally {
      setStreamingScene(null);
      streamAbortRef.current = null;
    }
  };

  const copyScene = async (num: number) => {
    try {
      await navigator.clipboard.writeText(sceneTexts[num] || '');
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopiedScene(num);
      copyTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setCopiedScene(null);
      }, 1500);
    } catch {
      setError('复制失败，请手动选择正文文本复制（部分浏览器需 HTTPS 或用户手势才允许写入剪贴板）。');
    }
  };

  const saveScene = (scene: StoryboardScene) => {
    const blob = new Blob([sceneTexts[scene.sceneNumber] || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const safeTitle = (scene.sceneTitle || 'scene').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 80) || 'scene';
    anchor.download = `${safeTitle}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // 至少需要 1 部 DNA 就绪作品（单本=自我裂变，多本=交叉融合）
  if (readyNovels.length < 1) {
    return (
      <div className="max-w-xl space-y-4">
        <h2 className="text-lg">融合工坊</h2>
        <p className="text-secondary">
          还差 {missingReadyCount} 部 DNA 就绪作品即可进入引力室。当前 {readyNovels.length} 部。
        </p>
        <p className="text-xs text-muted">单本可做「自我裂变」，多本可做「交叉融合」。</p>
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
          <p className="mt-1 text-sm text-secondary">选择 1 部做自我裂变，或 2 部以上交叉碰撞融合</p>
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
                aria-disabled={selectedIds.length < 1 || colliding}
                tabIndex={selectedIds.length < 1 || colliding ? -1 : 0}
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
                className={`relative z-10 w-10 h-10 rounded-full bg-black border border-[#1b1e36] flex items-center justify-center transition-all duration-300 ${selectedIds.length < 1 || colliding ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'} ${collisionPhase === 'charging' ? 'animate-core-charge' : ''}`}
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

        <div className="space-y-2">
          <p className="text-xs text-muted">反套路红队约束（可选）</p>
          <textarea
            value={adversarialRules}
            onChange={(e) => setAdversarialRules(e.target.value)}
            rows={2}
            placeholder="例如：禁止王子救公主套路、禁止开局废柴逆袭、对手必须有合理动机..."
            className="w-full border bg-transparent p-2 text-sm focus:outline-none"
          />
          <p className="text-[11px] text-muted">将作为硬约束贯穿碰撞 / 微调 / 故事板 / 正文全流程。</p>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {rateLimited && (
          <p className="text-xs text-amber-400">⏳ 云端限速中，已自动退避重试，请稍候…</p>
        )}

        <button
          onClick={collide}
          disabled={selectedIds.length < 1 || colliding}
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
      <style>{`
        .tweak-glow-pulse {
          animation: tweak-glow-pulse-anim 1.1s ease-in-out infinite;
        }
        @keyframes tweak-glow-pulse-anim {
          0%, 100% { box-shadow: 0 0 0 rgba(94,106,210,0.0); }
          50% { box-shadow: 0 0 16px rgba(94,106,210,0.55); }
        }
        @media (prefers-reduced-motion: reduce) {
          .tweak-glow-pulse {
            animation: none !important;
            transition: opacity 100ms ease-out;
          }
        }
      `}</style>
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
          <div
            key={key}
            className={`border p-3 transition-all ${tweakTarget === key ? 'border-primary' : 'border-default'} ${
              tweakingTarget && tweakingTarget !== key ? 'opacity-65' : 'opacity-100'
            } ${tweakingTarget === key && !prefersReducedMotion ? 'tweak-glow-pulse' : ''}`}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted">{label}</p>
              {tweakingTarget === key ? (
                <span className="text-[11px] text-primary">{prefersReducedMotion ? '更新中' : '脉冲更新中'}</span>
              ) : tweakingTarget && tweakingTarget !== key ? (
                <span className="text-[11px] text-muted">只读锁</span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-secondary leading-relaxed">{blocks[key]}</p>
          </div>
        ))}
      </div>

      {/* Tweak */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2 text-xs">
          {BLOCKS.map(({ key, label }) => (
            <button
              key={`tweak-target-${key}`}
              onClick={() => setTweakTarget(key)}
              disabled={tweaking}
              className={`border px-2 py-1 ${
                tweakTarget === key ? 'border-primary text-primary' : 'border-default text-secondary'
              } disabled:opacity-60`}
            >
              微调目标: {label}
            </button>
          ))}
        </div>
      <div className="flex gap-2">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runTweak()}
          placeholder={`对「${BLOCKS.find((block) => block.key === tweakTarget)?.label || '当前卡'}」输入调整指令...`}
          className="flex-1 border bg-transparent p-2 text-sm focus:outline-none"
          disabled={tweaking}
        />
        <button
          onClick={runTweak}
          disabled={tweaking || !command.trim()}
          className="px-3 text-sm text-secondary hover:text-primary disabled:text-muted"
        >
          {tweaking ? '发送中...' : '发送'}
        </button>
      </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {generatingBoard
          ? '故事板生成中'
          : streamingScene !== null
            ? `正在流式生成第 ${streamingScene} 分镜正文`
            : Object.values(sceneResumeStatus).some((status) => status === 'failed-resumable')
              ? '检测到中断，可点击继续接写'
            : error
              ? `发生错误：${error}`
              : '创作流程就绪'}
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {rateLimited && (
        <p className="text-xs text-amber-400">⏳ 云端限速中，已自动退避重试，请稍候…</p>
      )}

      {/* Storyboard */}
      <div className="space-y-4">
        <style>{`
          .storyboard-stream-panel {
            transition: opacity 100ms ease-out;
          }
        `}</style>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">故事板</span>
          <div className="flex items-center gap-3">
            {!generatingBoard && streamingScene === null && (
              <label className="flex items-center gap-1 text-xs text-muted">
                分镜数
                <select
                  value={sceneCount}
                  onChange={(e) => setSceneCount(Number(e.target.value))}
                  className="border border-default bg-transparent px-1 py-0.5 text-xs text-secondary focus:outline-none"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n} className="bg-black">
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {generatingBoard ? (
              <button onClick={() => streamAbortRef.current?.abort()} className="text-sm text-amber-400 hover:text-amber-300">
                停止生成
              </button>
            ) : (
              <button
                onClick={generateStoryboard}
                disabled={streamingScene !== null}
                className="text-sm text-secondary hover:text-primary disabled:text-muted"
              >
                {storyboard.length > 0 ? '重新生成故事板' : '生成故事板'}
              </button>
            )}
          </div>
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
                    <div className="flex flex-wrap items-center gap-4 text-xs">
                      <button onClick={() => copyScene(scene.sceneNumber)} className="text-muted hover:text-secondary">
                        {copiedScene === scene.sceneNumber ? '已复制 ✓' : '复制'}
                      </button>
                      <button onClick={() => saveScene(scene)} className="text-muted hover:text-secondary">下载</button>
                      {streamingScene === scene.sceneNumber ? (
                        <button onClick={() => streamAbortRef.current?.abort()} className="text-amber-400 hover:text-amber-300">
                          停止生成
                        </button>
                      ) : (
                        <button
                          onClick={() => generateScene(scene, 'fresh')}
                          disabled={streamingScene !== null}
                          className="text-muted hover:text-secondary disabled:opacity-50"
                        >
                          重写
                        </button>
                      )}
                      {sceneResumeStatus[scene.sceneNumber] === 'failed-resumable' && (
                        <button
                          onClick={() => generateScene(scene, 'resume')}
                          disabled={streamingScene !== null}
                          className="rounded border border-white/20 bg-white/10 px-2 py-0.5 text-primary backdrop-blur-sm hover:text-white disabled:text-muted"
                          aria-live="polite"
                        >
                          {sceneResumeStatus[scene.sceneNumber] === 'resuming' ? '续写中...' : '继续接写 ↩️'}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => generateScene(scene, 'fresh')}
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
