'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, isFourLayerDnaCard, isLegacyDnaCard } from '../app/db';
import { isDnaReady, isExtracting } from '../app/dnaState';
import { useAppStore } from '../app/store';
import { ensureLlmConfigReady } from '../app/llmClient';
import { runDnaExtraction, reconcileExtraction } from '../app/dnaEngine';
import { getLlmReadinessSummary } from '../app/workflow';
import AppDialog from './AppDialog';
import AppNotice from './AppNotice';

const EMPTY_CHAPTERS: Chapter[] = [];

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万字`;
  return `${count}字`;
}

function getDnaStepCopy({
  busy,
  dnaReady,
  needsReview,
  llmReady,
  hasFailures,
}: {
  busy: boolean;
  dnaReady: boolean;
  needsReview: boolean;
  llmReady: boolean;
  hasFailures: boolean;
}) {
  if (dnaReady) {
    return {
      title: 'DNA 已完成，可以进入创作阶段',
      body: '这本书的结构、节奏、题材与文笔已经提炼完成。现在你看到的不只是结果卡片，也是后续创作工坊会直接消费的输入资产。',
      next: '进入工坊，开始选择骨架与题材',
    };
  }
  if (busy) {
    return {
      title: '正在后台提取 DNA',
      body: '系统正在逐章分析并归纳整本书的创作骨架。你可以离开这个页面，提取会继续，完成后会回到统一的工作流里。',
      next: '等待提取完成，或去其他阶段继续浏览',
    };
  }
  if (needsReview) {
    return {
      title: '先修好切分，再提 DNA',
      body: '当前章节结构还不够稳定。如果现在直接提取，后端虽然能跑，但结果质量会受损，用户也会误以为产品逻辑有问题。',
      next: '回到切分校验台，修复章节边界',
    };
  }
  if (!llmReady) {
    return {
      title: '模型还没接通，DNA 无法开始',
      body: '当前断点不在内容本身，而在模型配置。把设置补齐后，这一段流程会自动恢复，不需要重新理解产品。',
      next: '打开设置，配置模型与密钥',
    };
  }
  if (hasFailures) {
    return {
      title: '有部分章节提取失败，建议继续补完',
      body: '大部分链路已经打通，但还有少量章节失败。继续提取会优先补齐这些失败点，而不是从头来一遍。',
      next: '继续提取并补齐失败章节',
    };
  }
  return {
      title: '当前可以开始 DNA 提取',
      body: '章节结构和模型配置都已满足条件。接下来系统会把这本书从“可阅读文本”推进成“可创作资产”。',
      next: '等待后台自动开始',
  };
}

export default function NovelDetail({ novelId }: { novelId: string }) {
  const { llmConfig, setManageMode, setWorkshopOpen, rateLimited } = useAppStore((state) => ({
    llmConfig: state.llmConfig,
    setManageMode: state.setManageMode,
    setWorkshopOpen: state.setWorkshopOpen,
    rateLimited: state.rateLimited,
  }));

  const novel = useLiveQuery(() => db.novels.get(novelId), [novelId]);
  const chapters = useLiveQuery(() => db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex'), [novelId]) || EMPTY_CHAPTERS;
  const readyNovelCount = useLiveQuery(() => db.novels.filter((item) => isDnaReady(item)).count(), []) || 0;

  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [confirmReextractOpen, setConfirmReextractOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const reconciledRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { reconciledRef.current = false; }, [novelId]);

  // 挂载对账（Critical）：刷新/崩溃后滞留 mapping/reducing 的孤儿态，交由运行器导出的 reconcileExtraction
  // 在单个事务内复位（analysisStatus → idle、卡在 mapping 的章 → pending）；复位后由 page.tsx 后台 manager 自动续跑。
  // 前向（resume 跳 done）与后向（本对账）现同住 dnaEngine/dnaState 接口后面，不再内联 db 写、无法独立漂移。
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

  if (!novel) return <div className="text-secondary">加载中...</div>;

  const llmReadiness = getLlmReadinessSummary(llmConfig);
  const progress = novel.mapProgress || { total: 0, current: 0 };
  const status = novel.analysisStatus;
  const busy = extracting || isExtracting(novel);
  const dnaReady = isDnaReady(novel);
  const dnaCard = novel.dnaCard ?? null;
  const needsReview = novel.splitStatus === 'needs_review';
  const oversizedChapter = chapters.find((c) => c.wordCount > 30000) || null;
  const failedChapters = chapters.filter((c) => c.mapStatus === 'error');
  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : status === 'reducing' ? 100 : 0;
  const dnaStepCopy = getDnaStepCopy({
    busy,
    dnaReady,
    needsReview: needsReview || Boolean(oversizedChapter),
    llmReady: llmReadiness.ok,
    hasFailures: failedChapters.length > 0,
  });
  const analyzedCount = chapters.filter((c) => c.mapStatus === 'done').length;
  const shortCount = chapters.filter((c) => c.wordCount < 500).length;
  const longCount = chapters.filter((c) => c.wordCount > 12000).length;

  // 重新提取 / 重试失败章（idle 起跑由 page.tsx 后台 manager 负责；这里仅覆盖 done/error 的手动入口）。
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

  return (
    <div className="atelier max-w-3xl">
      <div className="mb-6 rounded-[24px] border border-default bg-[linear-gradient(180deg,rgba(26,21,18,0.92),rgba(16,13,11,0.96))] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="eyebrow !mb-1">DNA 提取 · 工作流中段</div>
            <p className="text-sm leading-6 text-secondary">{dnaStepCopy.body}</p>
          </div>
          <div className="rounded-full border border-default bg-black/10 px-3 py-1 text-[11px] text-secondary">
            下一步 · <span className="text-primary">{dnaStepCopy.next}</span>
          </div>
        </div>
        <div className="mt-4 rounded-[20px] border border-default bg-black/10 p-4">
          <div className="text-[11px] uppercase tracking-[0.24em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>当前阶段</div>
          <div className="mt-2 text-sm text-primary">{dnaStepCopy.title}</div>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-secondary">
            <span className="rounded-full border border-default px-2.5 py-1">已分析 {analyzedCount} 章</span>
            <span className="rounded-full border border-default px-2.5 py-1">短章 {shortCount}</span>
            <span className="rounded-full border border-default px-2.5 py-1">长章 {longCount}</span>
            {busy ? (
              <span className="rounded-full border border-default px-2.5 py-1">
                {status === 'reducing' ? '正在归纳全书 DNA' : `正在提取章节 ${progress.current}/${progress.total || '…'}`}
              </span>
            ) : failedChapters.length > 0 ? (
              <span className="rounded-full border border-default px-2.5 py-1">{failedChapters.length} 个章节待补齐</span>
            ) : !llmReadiness.ok ? (
              <span className="rounded-full border border-default px-2.5 py-1">模型配置尚未就绪</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex items-start justify-between border-b border-default pb-4">
        <div>
          <div className="eyebrow">作品 DNA · 创作资产</div>
          <h1 className="atelier-h1" style={{ fontSize: 26 }}>{novel.name}</h1>
          <p className="mt-1 text-sm text-secondary">{formatWordCount(novel.wordCount)} · {chapters.length} 章</p>
        </div>
        <button onClick={() => setManageMode(true)} className="mini">章节裁切 ✂︎</button>
      </div>

      {dnaReady ? (
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm" style={{ color: 'var(--add)' }}>
              <span className="h-2 w-2 rounded-full" style={{ background: 'var(--add)' }} />
              DNA 已就绪
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setConfirmReextractOpen(true)}
                className="mini"
                title="基于全书重新归纳 DNA（覆盖当前结果）"
              >重新提取</button>
              {readyNovelCount >= 1 && (
                <button onClick={() => setWorkshopOpen(true)} className="cta" style={{ padding: '8px 16px', fontSize: 13 }}>进入工坊 →</button>
              )}
            </div>
          </div>

          {isFourLayerDnaCard(dnaCard) ? (
            <div className="setcards">
              <div className="setcard eng">
                <div className="lab"><span className="l">① 结构骨架 · 引擎</span></div>
                <div className="body">
                  {dnaCard.structureSkeleton.length === 0 ? '—' : dnaCard.structureSkeleton.map((b, i) => (
                    <div key={i}>{b.function}{b.summary ? ` — ${b.summary}` : ''}</div>
                  ))}
                </div>
              </div>
              <div className="setcard eng">
                <div className="lab"><span className="l">② 编排节奏 · 引擎</span></div>
                <div className="body">{dnaCard.pacingSyuzhet || '—'}</div>
              </div>
              <div className="setcard skn">
                <div className="lab"><span className="l">③ 题材皮</span></div>
                <div className="body">{dnaCard.themeSkin || '—'}</div>
              </div>
              <div className="setcard skn">
                <div className="lab"><span className="l">④ 文笔</span></div>
                <div className="body">{dnaCard.proseStyle || '—'}</div>
              </div>
            </div>
          ) : isLegacyDnaCard(dnaCard) ? (
            <div className="setcards">
              <div className="rounded-[9px] border px-3 py-2 text-xs" style={{ borderColor: 'var(--vermilion-line)', background: 'var(--vermilion-soft)', color: 'var(--vermilion)' }}>
                旧版 5 维 DNA（原文已保留不丢）。点「重新提取」可升级为引擎/皮 4 层模型。
              </div>
              {[
                { label: '母题', value: dnaCard.theme },
                { label: '世界观', value: dnaCard.worldview },
                { label: '角色', value: dnaCard.characters },
                { label: '叙事', value: dnaCard.narrativeStyle },
                { label: '风格', value: dnaCard.styleFingerprint },
              ].map(({ label, value }) => (
                <div key={label} className="setcard skn">
                  <div className="lab"><span className="l">{label}</span></div>
                  <div className="body">{value || '—'}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-6 space-y-5 max-w-xl">
          {!busy && (needsReview || oversizedChapter) && (
            <AppNotice
              tone="warning"
              title={oversizedChapter ? '存在超大章节，建议先裁切' : '章节切分质量偏低，建议先校验'}
              action={<button onClick={() => setManageMode(true)} className="mini">前往切分校验台 →</button>}
            >
                {oversizedChapter
                  ? `章节「${oversizedChapter.name}」超过 30,000 字。请先到切分校验台用剪刀或智能拆分裁小，自动提取才会启动。`
                  : '当前切分置信度较低，可能影响 DNA 质量。建议先校验修复，修复后会自动开始提取。'}
            </AppNotice>
          )}

          {!llmReadiness.ok && (
            <AppNotice
              tone="warning"
              title="模型未配置"
              action={<button onClick={() => window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }))} className="mini">配置模型密钥 →</button>}
            >
              {llmReadiness.reason}
            </AppNotice>
          )}

          {busy ? (
            <div className="rounded-[14px] border border-default bg-secondary p-6 space-y-4">
              <div className="flex items-center gap-2 text-sm text-primary">
                <span className="h-1.5 w-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: 'var(--vermilion)' }} />
                {status === 'reducing' ? '正在归纳全书创作 DNA…' : `正在提取 DNA ${progress.current}/${progress.total || '…'}`}
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: 'var(--vermilion)' }} />
              </div>
              {rateLimited && (
                <p className="text-xs" style={{ color: 'var(--vermilion)' }}>云端有些拥挤，已自动放缓退避重试，测序绝不中断。</p>
              )}
              <p className="text-[11px] text-muted">正在后台自动提取（按体量自适应），可切到别处，跑完会通知你。</p>
              <div className="rounded-[14px] border border-default bg-black/10 p-3 text-xs leading-6 text-secondary">
                当前状态会在这里持续更新，所以用户不用猜“系统是不是卡住了”，也不用切去别的面板确认后端有没有继续工作。
              </div>
            </div>
          ) : (
            <>
              {failedChapters.length > 0 && (
                <AppNotice
                  tone="error"
                  title={`${failedChapters.length} 个章节提取失败`}
                  action={<button onClick={() => void handleExtract()} className="mini">继续提取（重试失败处）</button>}
                >
                  <div className="max-h-24 space-y-1 overflow-y-auto">
                    {failedChapters.slice(0, 6).map((c) => (
                      <div key={c.id} className="truncate">第 {c.chapterIndex} 章 · {c.name}{c.errorMsg ? ` — ${c.errorMsg}` : ''}</div>
                    ))}
                    {failedChapters.length > 6 && <div className="text-muted">…等共 {failedChapters.length} 处</div>}
                  </div>
                </AppNotice>
              )}

              {llmReadiness.ok && (
              <div className="rounded-[14px] border border-default bg-black/10 p-4 text-xs leading-6 text-secondary">
                  DNA 会在后台自动按体量提取。若长时间没有推进，优先检查切分质量与模型配置。
                </div>
              )}

              <div className="flex gap-6 text-xs text-muted border-t border-default pt-4">
                <span>已分析: {analyzedCount} 章</span>
                <span>短章 (&lt;500字): {shortCount} 章</span>
                <span>长章 (&gt;12000字): {longCount} 章</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <AppNotice tone="error" className="mt-4 max-w-xl">
          {error}
        </AppNotice>
      )}

      {savedToast && (
        <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs shadow-2xl" style={{ borderColor: 'var(--add)', background: 'var(--ink-raise)', color: 'var(--add)' }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--add)' }} />
          {savedToast}
        </div>
      )}

      <AppDialog
        open={confirmReextractOpen}
        title="重新提取这本书的 DNA？"
        description="系统会基于当前全书内容重新归纳骨架、节奏、题材与文笔，并覆盖现有 DNA 结果。"
        confirmLabel="开始重新提取"
        onClose={() => setConfirmReextractOpen(false)}
        onConfirm={() => {
          setConfirmReextractOpen(false);
          void handleExtract();
        }}
      />
    </div>
  );
}
