'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Pencil, RotateCcw, ArrowRight, Check, Scissors } from 'lucide-react';
import { db, type Chapter, isFourLayerDnaCard, isLegacyDnaCard } from '../app/db';
import { isDnaReady, isExtracting } from '../app/dnaState';
import { useAppStore } from '../app/store';
import { ensureLlmConfigReady } from '../app/llmClient';
import { runDnaExtraction, reconcileExtraction } from '../app/dnaEngine';
import { getLlmReadinessSummary } from '../app/workflow';
import { routeBySize, buildArcWindows, selectSampledWindows, ARC_WINDOW_BUDGET_CHARS, SAMPLE_WINDOW_CAP, OVERSIZED_CHAPTER_CHARS } from '../app/dnaRouting';
import { type StructureBeat } from '../app/dnaSchema';
import AppDialog from './AppDialog';
import AppNotice from './AppNotice';

const EMPTY_CHAPTERS: Chapter[] = [];

const EDITABLE_STRING_LAYERS = ['pacingSyuzhet', 'themeSkin', 'proseStyle'] as const;
type StringLayer = (typeof EDITABLE_STRING_LAYERS)[number];
type EditableLayer = 'structureSkeleton' | StringLayer;

// 骨架整段文本 ⇄ StructureBeat[]：每行一个 beat，「功能 — 摘要」（摘要可省略）。宽容认 em/en/半角破折号。
function parseSkeleton(text: string): StructureBeat[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(.*?)\s[—–-]\s(.*)$/);
    return m ? { function: m[1].trim(), summary: m[2].trim() } : { function: line, summary: '' };
  });
}
function skeletonToText(beats: StructureBeat[]): string {
  return beats.map((b) => (b.summary ? `${b.function} — ${b.summary}` : b.function)).join('\n');
}

function getDnaStepCopy({
  busy, dnaReady, needsReview, llmReady, hasFailures,
}: {
  busy: boolean; dnaReady: boolean; needsReview: boolean; llmReady: boolean; hasFailures: boolean;
}) {
  if (dnaReady) return {
    title: 'DNA 已完成，可进入创作阶段',
    body: '这本书的结构、节奏、题材与文笔已提炼完成。你看到的不只是结果卡片，也是创作工坊会直接消费的输入资产。',
    next: '进入工坊，选择骨架与题材',
  };
  if (busy) return {
    title: '正在后台提取 DNA',
    body: '系统正在逐章分析并归纳整本书的创作骨架。你可以离开此页，提取会继续，完成后回到统一的工作流。',
    next: '等待提取完成，或去别处继续浏览',
  };
  if (needsReview) return {
    title: '先修好切分，再提 DNA',
    body: '当前章节结构还不够稳定。现在直接提取虽能跑，但结果质量会受损。',
    next: '到「章节校验」修复章节边界',
  };
  if (!llmReady) return {
    title: '模型还没接通，DNA 无法开始',
    body: '断点不在内容本身，而在模型配置。补齐设置后，这段流程会自动恢复。',
    next: '打开设置，配置模型与密钥',
  };
  if (hasFailures) return {
    title: '有部分章节提取失败，建议继续补完',
    body: '大部分链路已打通，仅少量章节失败。继续提取会优先补齐失败点，而非从头重来。',
    next: '继续提取并补齐失败章节',
  };
  return {
    title: '当前可以开始 DNA 提取',
    body: '章节结构与模型配置都已满足。接下来系统会把这本书从「可阅读文本」推进成「可创作资产」。',
    next: '等待后台自动开始',
  };
}

const ENGINE_LAYERS = [
  { key: 'pacingSyuzhet' as const, label: '② 编排节奏 · 引擎' },
];
const SKIN_LAYERS = [
  { key: 'themeSkin' as const, label: '③ 题材皮' },
  { key: 'proseStyle' as const, label: '④ 文笔' },
];

export default function NovelDetail({ novelId }: { novelId: string }) {
  const { llmConfig, setManageMode, setActiveCreationId, rateLimited } = useAppStore((state) => ({
    llmConfig: state.llmConfig,
    setManageMode: state.setManageMode,
    setActiveCreationId: state.setActiveCreationId,
    rateLimited: state.rateLimited,
  }));

  const novel = useLiveQuery(() => db.novels.get(novelId), [novelId]);
  const chapters = useLiveQuery(() => db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex'), [novelId]) || EMPTY_CHAPTERS;
  const readyNovelCount = useLiveQuery(() => db.novels.filter((item) => isDnaReady(item)).count(), []) || 0;

  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [confirmReextractOpen, setConfirmReextractOpen] = useState(false);
  const [editingLayer, setEditingLayer] = useState<EditableLayer | null>(null);
  const [layerDraft, setLayerDraft] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const reconciledRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { reconciledRef.current = false; }, [novelId]);

  // 挂载对账（Critical）：刷新/崩溃后滞留 mapping/reducing 的孤儿态，交由 reconcileExtraction 复位。
  useEffect(() => {
    if (!novel || extracting || abortRef.current) return;
    if (!isExtracting(novel)) return;
    if (reconciledRef.current) return;
    reconciledRef.current = true;
    void (async () => {
      await reconcileExtraction(novelId);
      setSavedToast('检测到上次提取被中断，已自动复位，将自动续跑。');
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setSavedToast(null), 3500);
    })();
  }, [novel, novelId, extracting]);

  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  if (!novel) return <div className="text-fg-muted">加载中…</div>;

  const llmReadiness = getLlmReadinessSummary(llmConfig);
  const progress = novel.mapProgress || { total: 0, current: 0 };
  const status = novel.analysisStatus;
  const busy = extracting || isExtracting(novel);
  const dnaReady = isDnaReady(novel);
  const dnaCard = novel.dnaCard ?? null;
  const needsReview = novel.splitStatus === 'needs_review';
  const oversizedChapter = chapters.find((c) => c.wordCount > OVERSIZED_CHAPTER_CHARS) || null;
  const failedChapters = chapters.filter((c) => c.mapStatus === 'error');
  const failureGroups = Array.from(
    failedChapters.reduce((m, c) => {
      const key = c.errorMsg?.trim() || '未知错误';
      return m.set(key, (m.get(key) || 0) + 1);
    }, new Map<string, number>()),
  ).map(([msg, count]) => ({ msg, count })).sort((a, b) => b.count - a.count);
  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : status === 'reducing' ? 100 : 0;
  const dnaStepCopy = getDnaStepCopy({
    busy, dnaReady, needsReview: needsReview || Boolean(oversizedChapter), llmReady: llmReadiness.ok, hasFailures: failedChapters.length > 0,
  });
  const analyzedCount = chapters.filter((c) => c.mapStatus === 'done').length;
  const shortCount = chapters.filter((c) => c.wordCount < 500).length;
  const longCount = chapters.filter((c) => c.wordCount > 12000).length;

  // 覆盖度透明带（纯展示·零存储）：据体量路由现算这次 DNA 覆盖了全书多少。
  const extractionRoute = routeBySize(novel.wordCount);
  const arcWindows = extractionRoute === 'direct' ? [] : buildArcWindows(chapters, ARC_WINDOW_BUDGET_CHARS);
  const coverageTotal = arcWindows.length;
  const coverageCovered = extractionRoute === 'sampling' ? selectSampledWindows(arcWindows, SAMPLE_WINDOW_CAP).length : coverageTotal;

  const handleExtract = async () => {
    if (!ensureLlmConfigReady(llmConfig).ok) {
      window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }));
      return;
    }
    setError(null);
    setExtracting(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runDnaExtraction(novelId, { signal: controller.signal });
    } catch (err) {
      setError(err instanceof Error ? err.message : '提取失败');
    } finally {
      setExtracting(false);
      abortRef.current = null;
    }
  };

  const enterWorkshop = () => setActiveCreationId(crypto.randomUUID());

  const startLayerEdit = (layer: EditableLayer, currentText: string) => { setEditingLayer(layer); setLayerDraft(currentText); };
  const cancelLayerEdit = () => { setEditingLayer(null); setLayerDraft(''); };
  const saveLayer = async (layer: EditableLayer) => {
    if (!isFourLayerDnaCard(dnaCard)) return;
    const nextCard = { ...dnaCard };
    if (layer === 'structureSkeleton') nextCard.structureSkeleton = parseSkeleton(layerDraft);
    else nextCard[layer] = layerDraft;
    await db.novels.update(novelId, { dnaCard: nextCard });
    setSavedToast('已保存修改，刷新后仍在');
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setSavedToast(null), 2500);
    setEditingLayer(null);
    setLayerDraft('');
  };

  const editBtn = (layer: EditableLayer, currentText: string) =>
    editingLayer !== layer && (
      <button onClick={() => startLayerEdit(layer, currentText)} className="btn btn-ghost btn-sm gap-1" aria-label="编辑">
        <Pencil size={12} /> 改
      </button>
    );

  const editor = (layer: EditableLayer, hint: string, minHeight = 90) =>
    editingLayer === layer && (
      <div className="mt-2">
        <textarea value={layerDraft} onChange={(e) => setLayerDraft(e.target.value)} className="input" style={{ minHeight }} placeholder={hint} />
        <div className="mt-2 flex items-center gap-2">
          <span className="flex-1 font-mono text-[11px] text-fg-subtle">{hint}</span>
          <button className="btn btn-ghost btn-sm" onClick={cancelLayerEdit}>取消</button>
          <button className="btn btn-primary btn-sm gap-1" onClick={() => void saveLayer(layer)}><Check size={13} /> 保存</button>
        </div>
      </div>
    );

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* 步骤指引条 */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow">DNA 提取 · 工作流中段</div>
            <p className="mt-1.5 text-sm leading-6 text-fg-muted">{dnaStepCopy.body}</p>
          </div>
          <span className="chip shrink-0">下一步 · {dnaStepCopy.next}</span>
        </div>
        <div className="mt-3 border-t border-line-2 pt-3">
          <div className="text-sm font-medium text-fg">{dnaStepCopy.title}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="chip">已分析 {analyzedCount} 章</span>
            <span className="chip">短章 {shortCount}</span>
            <span className="chip">长章 {longCount}</span>
            {busy && (
              <span className="chip text-accent">{status === 'reducing' ? '正在归纳全书 DNA' : `提取章节 ${progress.current}/${progress.total || '…'}`}</span>
            )}
          </div>
        </div>
      </div>

      {dnaReady ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium text-success">
              <span className="h-2 w-2 rounded-full bg-success" /> DNA 已就绪
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => setConfirmReextractOpen(true)} className="btn btn-secondary btn-sm gap-1.5" title="基于全书重新归纳 DNA（覆盖当前结果）">
                <RotateCcw size={13} /> 重新提取
              </button>
              {readyNovelCount >= 1 && (
                <button onClick={enterWorkshop} className="btn btn-primary btn-sm gap-1.5">进入工坊 <ArrowRight size={14} /></button>
              )}
            </div>
          </div>

          {/* 覆盖度带 */}
          <div className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="eyebrow">提取覆盖度</div>
              {extractionRoute === 'sampling'
                ? <span className="chip">采样估计</span>
                : <span className="chip text-success"><Check size={11} /> 全覆盖</span>}
            </div>
            <p className="mt-2 text-sm leading-6 text-fg-muted">
              {extractionRoute === 'direct'
                ? '整本直提：全文一次性进入长上下文提取，无章节遗漏。'
                : extractionRoute === 'arc'
                ? `弧窗全覆盖：全书分 ${coverageTotal} 个弧窗逐窗提取，已覆盖 ${coverageCovered}/${coverageTotal}。`
                : `饱和采样：全书 ${coverageTotal} 个弧窗中均匀实测 ${coverageCovered} 个（含首尾）；超大体量下为避免卡死，这是非全覆盖的估计。`}
            </p>
          </div>

          {isFourLayerDnaCard(dnaCard) ? (
            <div className="space-y-3">
              {/* ① 结构骨架 */}
              <div className="card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="eyebrow">① 结构骨架 · 引擎</span>
                  {editBtn('structureSkeleton', skeletonToText(dnaCard.structureSkeleton))}
                </div>
                {editingLayer === 'structureSkeleton'
                  ? editor('structureSkeleton', '每行一个 beat：功能 — 摘要（摘要可省略）', 150)
                  : (
                    <div className="mt-2 space-y-1 font-mono text-[13px] leading-relaxed text-fg-muted">
                      {dnaCard.structureSkeleton.length === 0 ? '—' : dnaCard.structureSkeleton.map((b, i) => (
                        <div key={i}><span className="text-fg">{b.function}</span>{b.summary ? ` — ${b.summary}` : ''}</div>
                      ))}
                    </div>
                  )}
              </div>
              {/* ②③④ */}
              {[...ENGINE_LAYERS, ...SKIN_LAYERS].map(({ key, label }) => (
                <div key={key} className="card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="eyebrow">{label}</span>
                    {editBtn(key, dnaCard[key] || '')}
                  </div>
                  {editingLayer === key
                    ? editor(key, '手动编辑')
                    : <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg">{dnaCard[key] || '—'}</div>}
                </div>
              ))}
            </div>
          ) : isLegacyDnaCard(dnaCard) ? (
            <div className="space-y-3">
              <AppNotice tone="info">旧版 5 维 DNA（原文已保留不丢）。点「重新提取」可升级为引擎/皮 4 层模型。</AppNotice>
              {[
                { label: '母题', value: dnaCard.theme },
                { label: '世界观', value: dnaCard.worldview },
                { label: '角色', value: dnaCard.characters },
                { label: '叙事', value: dnaCard.narrativeStyle },
                { label: '风格', value: dnaCard.styleFingerprint },
              ].map(({ label, value }) => (
                <div key={label} className="card p-4">
                  <div className="eyebrow">{label}</div>
                  <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg">{value || '—'}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="max-w-xl space-y-4">
          {!busy && (needsReview || oversizedChapter) && (
            <AppNotice
              tone="warning"
              title={oversizedChapter ? '存在超大章节，建议先裁切' : '章节切分质量偏低，建议先校验'}
              action={<button onClick={() => setManageMode(true)} className="btn btn-secondary btn-sm gap-1.5"><Scissors size={13} /> 前往章节校验</button>}
            >
              {oversizedChapter
                ? `章节「${oversizedChapter.name}」超过 48,000 字。提取时超出单弧窗上限的尾部会被截断、削弱该段 DNA 覆盖；建议先到章节校验用剪刀或智能拆分裁小，再提取。`
                : '当前切分置信度较低，可能影响 DNA 质量。建议先校验修复，修复后会自动开始提取。'}
            </AppNotice>
          )}

          {!llmReadiness.ok && (
            <AppNotice
              tone="warning"
              title="模型未配置"
              action={<button onClick={() => window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }))} className="btn btn-secondary btn-sm">配置模型密钥</button>}
            >
              {llmReadiness.reason}
            </AppNotice>
          )}

          {busy ? (
            <div className="card space-y-4 p-5">
              <div className="flex items-center gap-2 text-sm text-fg">
                <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
                {status === 'reducing' ? '正在归纳全书创作 DNA…' : `正在提取 DNA ${progress.current}/${progress.total || '…'}`}
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
              </div>
              {rateLimited && <p className="text-xs text-accent">云端有些拥挤，已自动放缓退避重试，测序绝不中断。</p>}
              <p className="text-xs leading-6 text-fg-muted">正在后台自动提取（按体量自适应），可切到别处，跑完会通知你。当前状态会在这里持续更新。</p>
            </div>
          ) : (
            <>
              {failedChapters.length > 0 && (
                <AppNotice
                  tone="error"
                  title={`${failedChapters.length} 个章节提取失败`}
                  action={<button onClick={() => void handleExtract()} className="btn btn-secondary btn-sm">继续提取（重试失败处）</button>}
                >
                  <div className="max-h-32 space-y-1.5 overflow-y-auto">
                    {failureGroups.map(({ msg, count }) => (
                      <div key={msg} className="flex items-start gap-2">
                        <span className="mt-px shrink-0 rounded border border-line px-1.5 text-[11px] leading-4 text-fg-subtle">{count}</span>
                        <span className="leading-5">{msg}</span>
                      </div>
                    ))}
                  </div>
                </AppNotice>
              )}

              {llmReadiness.ok && (
                <div className="card p-4 text-xs leading-6 text-fg-muted">
                  DNA 会在后台自动按体量提取。若长时间没有推进，优先检查切分质量与模型配置。
                </div>
              )}

              <div className="flex gap-6 border-t border-line pt-4 text-xs text-fg-subtle">
                <span>已分析 {analyzedCount} 章</span>
                <span>短章（&lt;500字）{shortCount} 章</span>
                <span>长章（&gt;12000字）{longCount} 章</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && <AppNotice tone="error">{error}</AppNotice>}

      {savedToast && (
        <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-accent/30 bg-surface px-4 py-2.5 text-xs text-accent shadow-pop">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" /> {savedToast}
        </div>
      )}

      <AppDialog
        open={confirmReextractOpen}
        title="重新提取这本书的 DNA？"
        description="系统会基于当前全书内容重新归纳骨架、节奏、题材与文笔，并覆盖现有 DNA 结果。"
        confirmLabel="开始重新提取"
        onClose={() => setConfirmReextractOpen(false)}
        onConfirm={() => { setConfirmReextractOpen(false); void handleExtract(); }}
      />
    </div>
  );
}
