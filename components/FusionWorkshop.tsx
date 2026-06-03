'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, isFourLayerDnaCard, type FusionSession, type SettingSnapshot, type StructureBeat } from '../app/db';
import { RateLimitSignal, withRateLimitRetry } from '../app/dnaEngine';
import { StreamSseError, ensureLlmConfigReady, postWithLlmConfig, readApiErrorMessage, streamSse } from '../app/llmClient';
import { appendSnapshot, popSnapshot } from '../app/settingHistory';
import { computeDiff, type DiffSegment } from '../app/diff';
import { useAppStore } from '../app/store';

interface FusionDirection {
  title: string;
  concept: string;
  catalyst: string;
  worldviewBlock: string;
  protagonistBlock: string;
  antagonistBlock: string;
  narrativeTone: string;
  transferNote?: string;
}

interface RepairGap { beat: string; issue: string; patch: string; }

interface FusionRecipe {
  engineCard: { novelName: string; structureSkeleton: StructureBeat[]; pacingSyuzhet: string };
  skinSource: { novelName: string; themeSkin: string; proseStyle: string; userBrief: string };
  mode: 'self' | 'cross';
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

interface PendingDiff { block: BlockKey; oldText: string; newText: string; why: string; }
interface IntentState { instruction: string; brief: string; confirmation: string; }
interface FragmentDraft { original: string; rewritten: string; }

export default function FusionWorkshop() {
  const { setSelectedNovelId, setWorkshopOpen, rateLimited, activeCreationId, setWorkshopBusy } = useAppStore((state) => ({
    setSelectedNovelId: state.setSelectedNovelId,
    setWorkshopOpen: state.setWorkshopOpen,
    rateLimited: state.rateLimited,
    activeCreationId: state.activeCreationId,
    setWorkshopBusy: state.setWorkshopBusy,
  }));
  const novels = useLiveQuery(() => db.novels.reverse().toArray(), []) || [];
  const readyNovels = novels.filter((novel) => novel.analysisStatus === 'done' && novel.dnaCard);
  const firstIncompleteNovel = novels.find((novel) => novel.analysisStatus !== 'done' || !novel.dnaCard) || novels[0] || null;

  const [step, setStep] = useState<'material' | 'directions' | 'creator' | 'manuscript'>('material');
  // selectedIds[0] = 骨架(引擎)，selectedIds[1] = 题材(皮)；皮可缺省（自我裂变，题材取口述）。
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [colliding, setColliding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [directions, setDirections] = useState<FusionDirection[]>([]);
  const [blocks, setBlocks] = useState<Record<BlockKey, string>>(EMPTY_BLOCKS);
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
  const [settingHistory, setSettingHistory] = useState<SettingSnapshot[]>([]);

  // 创世台共创态
  const [editingBlock, setEditingBlock] = useState<BlockKey | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [pendingDiff, setPendingDiff] = useState<PendingDiff | null>(null);
  const [intent, setIntent] = useState<IntentState | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  // 成稿选中句轻量改写
  const [selectedFragment, setSelectedFragment] = useState<string>('');
  const [fragmentDraft, setFragmentDraft] = useState<FragmentDraft | null>(null);
  const [rewriting, setRewriting] = useState(false);

  const mountedRef = useRef(true);
  const streamAbortRef = useRef<AbortController | null>(null);
  const hydratedRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
    streamAbortRef.current?.abort();
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
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
        setSettingHistory(saved.settingHistory || []);
      } else {
        setSelectedIds([]); setCustomPrompt(''); setAdversarialRules(''); setStep('material');
        setDirections([]); setBlocks(EMPTY_BLOCKS); setDirectionTitle('');
        setSceneTexts({}); setSceneResumeStatus({}); setSettingHistory([]);
      }
      setPendingDiff(null); setIntent(null); setEditingBlock(null); setRepairGaps([]);
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
        storyboard: [],
        sceneTexts,
        sceneResumeStatus,
        settingHistory,
        updatedAt: Date.now(),
      };
      await db.fusionSessions.put(session);
    });
  }, [
    activeCreationId, step, selectedIds, customPrompt, adversarialRules, directions, blocks,
    directionTitle, sceneTexts, sceneResumeStatus, settingHistory,
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
    setWorkshopBusy(streamingScene !== null || colliding || tweaking || repairing || rewriting || enhancing);
  }, [streamingScene, colliding, tweaking, repairing, rewriting, enhancing, setWorkshopBusy]);
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

  const collide = async () => {
    if (!guardLlm() || colliding) return;
    const recipe = buildRecipe();
    if ('error' in recipe) { setError(recipe.error); return; }
    setError(null);
    setColliding(true);
    try {
      const ac = new AbortController();
      const data = await withRateLimitRetry(async () => {
        const response = await postWithLlmConfig('/api/py/generate-fusion-directions', {
          engineCard: recipe.engineCard,
          skinSource: recipe.skinSource,
          mode: recipe.mode,
          userCustomPrompt: recipe.mode === 'cross' ? (customPrompt.trim() || undefined) : undefined,
          adversarialRules: adversarialRules.trim() || undefined,
        }, { signal: ac.signal });
        if (response.status === 429) throw new RateLimitSignal();
        if (!response.ok) throw new Error(await readApiErrorMessage(response));
        return (await response.json()) as { directions: FusionDirection[] };
      }, { signal: ac.signal });
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

  const chooseDirection = async (direction: FusionDirection) => {
    if (Object.keys(sceneTexts).length > 0 && !window.confirm('切换方向会清空当前开篇正文，确定切换？')) return;
    const baseBlocks = {
      worldviewBlock: direction.worldviewBlock,
      protagonistBlock: direction.protagonistBlock,
      antagonistBlock: direction.antagonistBlock,
      narrativeTone: direction.narrativeTone,
    };
    setDirectionTitle(direction.title);
    setBlocks(baseBlocks);
    setSceneTexts({}); setSceneResumeStatus({}); setRepairGaps([]); setSettingHistory([]);
    setPendingDiff(null); setIntent(null); setEditingBlock(null);
    setTweakTarget('worldviewBlock');
    setStep('creator');

    const recipe = buildRecipe();
    if ('error' in recipe) return;
    setError(null);
    setRepairing(true);
    try {
      const ac = new AbortController();
      const repaired = await withRateLimitRetry(async () => {
        const response = await postWithLlmConfig('/api/py/repair-setting-gaps', {
          ...baseBlocks,
          structureSkeleton: recipe.engineCard.structureSkeleton,
          themeSkin: recipe.skinSource.themeSkin || recipe.skinSource.userBrief || '',
          adversarialRules: adversarialRules.trim() || undefined,
        }, { signal: ac.signal });
        if (response.status === 429) throw new RateLimitSignal();
        if (!response.ok) throw new Error(await readApiErrorMessage(response));
        return (await response.json()) as { worldviewBlock: string; protagonistBlock: string; antagonistBlock: string; narrativeTone: string; gaps?: RepairGap[] };
      }, { signal: ac.signal });
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

  // ---- 创世台：手动直接编辑 ----
  const startEdit = (key: BlockKey) => { setPendingDiff(null); setEditingBlock(key); setEditDraft(blocks[key]); };
  const cancelEdit = () => { setEditingBlock(null); setEditDraft(''); };
  const saveEdit = (key: BlockKey) => {
    if (editDraft === blocks[key]) { cancelEdit(); return; }
    setSettingHistory((h) => appendSnapshot(h, blocks, `手改：${BLOCKS.find((b) => b.key === key)?.label ?? ''}`, Date.now()));
    setBlocks((prev) => ({ ...prev, [key]: editDraft }));
    cancelEdit();
  };

  // ---- 创世台：AI 指令 → diff（不静默覆盖）----
  const runTweak = async (rawInstruction?: string) => {
    const instruction = (rawInstruction ?? command).trim();
    if (!guardLlm() || !instruction || tweaking) return;
    setError(null);
    setEditingBlock(null);
    setTweaking(true);
    try {
      const ac = new AbortController();
      const data = await withRateLimitRetry(async () => {
        const response = await postWithLlmConfig('/api/py/tweak-fusion-blocks', {
          ...blocks,
          targetBlock: tweakTarget,
          userInstruction: instruction,
          adversarialRules: adversarialRules.trim() || undefined,
        }, { signal: ac.signal });
        if (response.status === 429) throw new RateLimitSignal();
        if (!response.ok) throw new Error(await readApiErrorMessage(response));
        return (await response.json()) as Partial<Record<BlockKey, string>> & { modifiedBlocks: BlockKey[] };
      }, { signal: ac.signal });
      if (!mountedRef.current) return;
      const reported = (data.modifiedBlocks || []).filter((k): k is BlockKey => isBlockKey(k));
      const newText = reported.includes(tweakTarget) && typeof data[tweakTarget] === 'string' ? (data[tweakTarget] as string) : null;
      if (newText === null || newText === blocks[tweakTarget]) {
        setError('该指令未改动当前目标卡，换个说法或先切换目标卡。');
        return;
      }
      // 不直接套用：先出 diff，待用户接受/拒绝。
      setPendingDiff({ block: tweakTarget, oldText: blocks[tweakTarget], newText, why: instruction });
      setCommand('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '调整失败');
    } finally {
      if (mountedRef.current) setTweaking(false);
    }
  };
  const acceptDiff = () => {
    if (!pendingDiff) return;
    setSettingHistory((h) => appendSnapshot(h, blocks, `AI 改：${pendingDiff.why}`, Date.now()));
    setBlocks((prev) => ({ ...prev, [pendingDiff.block]: pendingDiff.newText }));
    setPendingDiff(null);
  };
  const rejectDiff = () => setPendingDiff(null);

  // ---- ✨ 意图增强（带确认门）----
  const enhance = async () => {
    const instruction = command.trim();
    if (!guardLlm() || !instruction || enhancing) return;
    setError(null);
    setEnhancing(true);
    try {
      const ac = new AbortController();
      const data = await withRateLimitRetry(async () => {
        const response = await postWithLlmConfig('/api/py/enhance-instruction', {
          userInstruction: instruction,
          targetBlock: tweakTarget,
          blockContext: blocks[tweakTarget] || '',
        }, { signal: ac.signal });
        if (response.status === 429) throw new RateLimitSignal();
        if (!response.ok) throw new Error(await readApiErrorMessage(response));
        return (await response.json()) as { interpretedBrief: string; confirmation: string };
      }, { signal: ac.signal });
      if (!mountedRef.current) return;
      setIntent({ instruction, brief: data.interpretedBrief, confirmation: data.confirmation });
    } catch (err) {
      setError(err instanceof Error ? err.message : '增强意图失败');
    } finally {
      if (mountedRef.current) setEnhancing(false);
    }
  };
  const confirmIntent = () => {
    if (!intent) return;
    const brief = intent.brief;
    setIntent(null);
    void runTweak(brief);
  };
  const cancelIntent = () => setIntent(null);

  const revertSetting = () => {
    const { restored, history } = popSnapshot(settingHistory);
    if (!restored) return;
    setBlocks(restored.blocks);
    setSettingHistory(history);
    setPendingDiff(null);
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
      <div className="atelier max-w-xl">
        <div className="eyebrow">Workbench · 工作台</div>
        <h2 className="atelier-h1">先让书<span className="it">就绪</span>。</h2>
        <p className="lede">还没有 DNA 就绪的作品。导入一本 TXT，工坊会在后台自动提取它的创作 DNA，就绪后即可来这里换皮起书。</p>
        {firstIncompleteNovel && (
          <button className="cta ghost" onClick={() => { setWorkshopOpen(false); setSelectedNovelId(firstIncompleteNovel.id); }}>
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
        <div className="eyebrow">Recipe · 配方台</div>
        <h2 className="atelier-h1">谁当<span className="it">骨架</span>，谁换<span className="it">皮</span>?</h2>
        <p className="lede">这是你唯一要拧的「旋钮」——没有滑块、没有参数。指认两本书的角色（或单本自我裂变），其余交给工坊。</p>

        <div className="recipe">
          <div className="slab engine">
            <div className="role">🔧 骨架 · ENGINE</div>
            <select
              className="bk"
              style={{ background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', maxWidth: '100%' }}
              value={selectedIds[0] || ''}
              onChange={(e) => pickEngine(e.target.value)}
            >
              <option value="" disabled>选择骨架书…</option>
              {readyNovels.map((n) => (
                <option key={n.id} value={n.id} className="bg-black">{n.name}{isFourLayerDnaCard(n.dnaCard) ? '' : '（旧版DNA）'}</option>
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
            <div className="role">🎨 题材 · SKIN</div>
            <select
              className="bk"
              style={{ background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', maxWidth: '100%', color: 'var(--paper-text)' }}
              value={selectedIds[1] || ''}
              onChange={(e) => pickSkin(e.target.value)}
              disabled={!engineNovel}
            >
              <option value="">（口述题材 · 自我裂变）</option>
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
              <div className="layerline"><span className="k">自我裂变</span>无题材书——在下方「想往哪写」里口述你想要的新题材，工坊据此另起一炉。</div>
            )}
          </div>
        </div>

        <div className="wishbar">
          <input
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={skinNovel ? '想往哪写?想避开什么套路?（可留空，留空=纯靠两本书的 DNA）' : '口述新题材 / 想往哪写（自我裂变必填一点方向）'}
          />
          <span className="opt">{skinNovel ? '可选' : '建议填写'}</span>
        </div>

        <div className="space-y-2">
          <textarea
            value={adversarialRules}
            onChange={(e) => setAdversarialRules(e.target.value)}
            rows={2}
            placeholder="反套路约束（可选）：例如 禁止王子救公主、禁止开局废柴龙傲天、对手必须有合理动机…"
            className="w-full rounded-[11px] border border-default bg-secondary p-3 text-sm text-secondary focus:outline-none focus:border-[color:var(--vermilion-line)]"
            style={{ fontFamily: 'var(--font-serif)' }}
          />
        </div>

        {recipeErr && <p className="mt-3 text-sm" style={{ color: 'var(--del)' }}>{recipeErr}</p>}
        {error && <p className="mt-2 text-sm" style={{ color: 'var(--del)' }}>{error}</p>}
        {rateLimited && <p className="mt-2 text-xs" style={{ color: 'var(--vermilion)' }}>云端有些拥挤，已自动放缓退避重试，请稍候…</p>}

        <div className="mt-6">
          <button className="cta" onClick={collide} disabled={colliding || !engineNovel}>
            {colliding ? '生成中…' : '生成 3 个方向'} <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>→</span>
          </button>
        </div>
      </div>
    );
  }

  // ===== 三方向 =====
  if (step === 'directions') {
    const idxLabel = ['i.', 'ii.', 'iii.', 'iv.', 'v.'];
    const engName = engineNovel?.name || '骨架';
    const skinLabel = skinNovel?.name || '口述题材';
    return (
      <div className="atelier">
        <div className="eyebrow">Directions · 三方向</div>
        <h2 className="atelier-h1">三种<span className="it">嫁接</span>法。挑一个。</h2>
        <p className="lede">同一套「{engName} 的引擎 × {skinLabel} 的皮」，三个不同的化学反应。这是你的第一个创作决定。</p>
        <div className="dirs">
          {directions.map((dir, idx) => (
            <button key={idx} className="dir" onClick={() => void chooseDirection(dir)}>
              <span className="idx">{idxLabel[idx] || `${idx + 1}.`}</span>
              <h4>{dir.title}</h4>
              <p className="concept">{dir.concept}</p>
              {dir.transferNote && <p className="concept" style={{ color: 'var(--ink-faint)', fontSize: 12 }}>🧬 {dir.transferNote}</p>}
              <div className="recipe-tag">
                <span className="chip eng">{engName}</span>
                <span className="chip skn">{skinLabel}</span>
              </div>
              <span className="pick">选择此方向 ↗</span>
            </button>
          ))}
        </div>
        <div className="mt-7">
          <button className="cta ghost" onClick={() => setStep('material')}>← 回配方台</button>
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
    const diffSegments = (seg: DiffSegment[]) =>
      seg.map((s, i) => s.op === 'equal'
        ? <span key={i}>{s.text}</span>
        : <span key={i} className={s.op === 'add' ? 'add' : 'del'}>{s.text}</span>);

    return (
      <div className="atelier">
        <div className="eyebrow">Studio · 创世台 · 确认设定</div>
        <h2 className="atelier-h1">定<span className="it">地基</span>。想改就跟我说。</h2>
        <p className="lede">换皮已自动完成并补好逻辑洞。这是你的第二个、也是最后一个创作决定——任何 AI 改动都先给你看 diff，你说了算。</p>

        {repairing && (
          <div className="mb-4 flex items-center gap-2 rounded-[9px] border px-3 py-2 text-xs" style={{ borderColor: 'var(--vermilion-line)', background: 'var(--vermilion-soft)', color: 'var(--vermilion)' }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: 'var(--vermilion)' }} />
            正在补洞：核对新题材能否撑起原结构骨架，修补逻辑断裂点…
          </div>
        )}
        {!repairing && repairGaps.length > 0 && (
          <details className="mb-4 rounded-[9px] border px-3 py-2 text-xs" style={{ borderColor: 'var(--add)', background: 'var(--add-soft)', color: '#a7d8b4' }}>
            <summary className="cursor-pointer select-none">🩹 已自动补洞 {repairGaps.length} 处，使换皮设定逻辑自洽（点开查看）</summary>
            <ul className="mt-2 space-y-1.5" style={{ color: 'var(--ink-dim)' }}>
              {repairGaps.map((g, i) => (<li key={i}><b style={{ color: '#a7d8b4' }}>{g.beat}</b>：{g.issue} → {g.patch}</li>))}
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
              const showDiff = pendingDiff?.block === key;
              const editing = editingBlock === key;
              return (
                <div
                  key={key}
                  className={`setcard skn ${showDiff ? 'diff' : ''}`}
                  style={active ? { borderColor: 'var(--vermilion-line)' } : undefined}
                  onClick={() => { if (!editing) setTweakTarget(key); }}
                >
                  <div className="lab">
                    <span className="l">{label}</span>
                    <span className="src">引擎《{engSrc}》· 题材《{skinSrc}》</span>
                    {!editing && !showDiff && <button className="editbtn" onClick={(e) => { e.stopPropagation(); startEdit(key); }}>✎ 改</button>}
                  </div>
                  {editing ? (
                    <div onClick={(e) => e.stopPropagation()}>
                      <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} />
                      <div className="diffbar"><span className="why">手动编辑</span>
                        <button className="mini" onClick={cancelEdit}>取消</button>
                        <button className="mini accept" onClick={() => saveEdit(key)}>保存</button>
                      </div>
                    </div>
                  ) : showDiff && pendingDiff ? (
                    <>
                      <div className="body">{diffSegments(computeDiff(pendingDiff.oldText, pendingDiff.newText))}</div>
                      <div className="diffbar" onClick={(e) => e.stopPropagation()}>
                        <span className="why">✨ {pendingDiff.why}</span>
                        <button className="mini" onClick={rejectDiff}>拒绝</button>
                        <button className="mini accept" onClick={acceptDiff}>接受改动</button>
                      </div>
                    </>
                  ) : (
                    <div className="body">{blocks[key] || '—'}</div>
                  )}
                </div>
              );
            })}
          </div>

          <aside className="copilot">
            <h5>与 AI 共创</h5>
            <div className="sub">点一张卡选中目标（当前：{BLOCKS.find((b) => b.key === tweakTarget)?.label}）。说一句大白话，或点 ✨ 让我先理清你的意图。</div>
            {intent && (
              <div className="intent">我理解你要：<b>{intent.brief}</b>{intent.confirmation ? <><br />{intent.confirmation}</> : null}
                <div className="ic">
                  <button className="mini" onClick={cancelIntent}>不对，我再说</button>
                  <button className="mini accept" onClick={confirmIntent}>对，改</button>
                </div>
              </div>
            )}
            <div className="aibox">
              <textarea
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={`对「${BLOCKS.find((b) => b.key === tweakTarget)?.label}」说：把主角换成女性 / 开篇更孤独 / 金手指更克制…`}
              />
              <div className="ar">
                <button className="enhance" onClick={() => void enhance()} disabled={enhancing || tweaking || !command.trim()}>✨ {enhancing ? '理清中…' : '增强我的意图'}</button>
                <button className="send" onClick={() => void runTweak()} disabled={tweaking || enhancing || !command.trim()} title="发送指令">{tweaking ? '…' : '↑'}</button>
              </div>
            </div>
            {settingHistory.length > 0 && (
              <button className="ver" onClick={revertSetting} disabled={tweaking || repairing}>⟲ 版本历史 · 一键回退上一步（已存 {settingHistory.length} 版）</button>
            )}
          </aside>
        </div>

        {error && <p className="mt-4 text-sm" style={{ color: 'var(--del)' }}>{error}</p>}
        {rateLimited && <p className="mt-2 text-xs" style={{ color: 'var(--vermilion)' }}>云端有些拥挤，已自动退避重试，请稍候…</p>}

        <div className="mt-7 flex gap-3">
          <button className="cta" onClick={goManuscript} disabled={repairing || !!pendingDiff}>确认设定 · 开始写开篇 →</button>
          <button className="cta ghost" onClick={() => setStep('directions')}>← 换个方向</button>
        </div>
      </div>
    );
  }

  // ===== 成稿 =====
  const prose = sceneTexts[OPENING_SCENE_NUM] || '';
  const resume = sceneResumeStatus[OPENING_SCENE_NUM];
  const streaming = streamingScene === OPENING_SCENE_NUM;
  return (
    <div className="atelier">
      <div className="eyebrow">Manuscript · 成稿</div>
      <h2 className="atelier-h1">墨，正落在<span className="it">纸</span>上。</h2>
      <p className="lede">开篇正文流式生成中。选中任意一句，就能让 AI 就地改写——改动同样先给你看、你接受才算数。</p>

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
      {rateLimited && <p className="mt-2 text-xs" style={{ color: 'var(--vermilion)' }}>云端有些拥挤，已自动退避重试，请稍候…</p>}
    </div>
  );
}
