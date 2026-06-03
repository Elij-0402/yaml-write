'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, isFourLayerDnaCard, isLegacyDnaCard } from '../app/db';
import { useAppStore } from '../app/store';
import { ensureLlmConfigReady } from '../app/llmClient';
import { runDnaExtraction } from '../app/dnaEngine';
import { getLlmReadinessSummary } from '../app/workflow';

const EMPTY_CHAPTERS: Chapter[] = [];

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万字`;
  return `${count}字`;
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
  const readyNovelCount = useLiveQuery(() => db.novels.filter((item) => item.analysisStatus === 'done' && Boolean(item.dnaCard)).count(), []) || 0;

  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reconciledRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { reconciledRef.current = false; }, [novelId]);

  // 挂载对账（Critical）：刷新/崩溃后 analysisStatus 仍为 mapping/reducing 的孤儿态复位为 idle、
  // 把卡在 mapping 的章回滚 pending；复位后由 page.tsx 的后台 manager 自动续跑（提取可续跑）。
  useEffect(() => {
    if (!novel || extracting || abortRef.current) return;
    if (novel.analysisStatus !== 'mapping' && novel.analysisStatus !== 'reducing') return;
    if (reconciledRef.current) return;
    reconciledRef.current = true;
    void (async () => {
      await db.novels.update(novelId, { analysisStatus: 'idle' });
      await db.chapters.where('novelId').equals(novelId).and((c) => c.mapStatus === 'mapping').modify({ mapStatus: 'pending' });
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
  const busy = extracting || status === 'mapping' || status === 'reducing';
  const dnaReady = status === 'done' && novel.dnaCard;
  const dnaCard = novel.dnaCard ?? null;
  const needsReview = novel.splitStatus === 'needs_review';
  const oversizedChapter = chapters.find((c) => c.wordCount > 30000) || null;
  const failedChapters = chapters.filter((c) => c.mapStatus === 'error');
  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : status === 'reducing' ? 100 : 0;

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
      <div className="flex items-start justify-between border-b border-default pb-4">
        <div>
          <div className="eyebrow">Book DNA · 创作 DNA</div>
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
                onClick={() => { if (window.confirm('将基于全书重新提取并覆盖当前 DNA，确定继续？')) void handleExtract(); }}
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
            <div className="rounded-[11px] border p-4 text-sm" style={{ borderColor: 'var(--vermilion-line)', background: 'var(--vermilion-soft)' }}>
              <div className="font-semibold" style={{ color: 'var(--vermilion)' }}>
                {oversizedChapter ? '存在超大章节，建议先裁切' : '章节切分质量偏低，建议先校验'}
              </div>
              <p className="mt-2 text-xs text-secondary leading-relaxed">
                {oversizedChapter
                  ? `章节「${oversizedChapter.name}」超过 30,000 字。请先到切分校验台用剪刀或智能拆分裁小，自动提取才会启动。`
                  : '当前切分置信度较低，可能影响 DNA 质量。建议先校验修复，修复后会自动开始提取。'}
              </p>
              <button onClick={() => setManageMode(true)} className="mini mt-3">前往切分校验台 →</button>
            </div>
          )}

          {!llmReadiness.ok && (
            <div className="rounded-[11px] border p-4 text-sm" style={{ borderColor: 'var(--vermilion-line)', background: 'var(--vermilion-soft)' }}>
              <div className="font-semibold" style={{ color: 'var(--vermilion)' }}>模型未配置</div>
              <p className="mt-2 text-xs text-secondary leading-relaxed">{llmReadiness.reason}</p>
              <button onClick={() => window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }))} className="mini mt-3">配置模型密钥 →</button>
            </div>
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
            </div>
          ) : (
            <>
              {failedChapters.length > 0 && (
                <div className="rounded-[11px] border p-4 text-sm space-y-3" style={{ borderColor: 'var(--del)', background: 'var(--del-soft)' }}>
                  <div className="font-semibold" style={{ color: 'var(--del)' }}>{failedChapters.length} 个弧窗 / 章节提取失败</div>
                  <div className="space-y-1 max-h-24 overflow-y-auto text-xs text-secondary">
                    {failedChapters.slice(0, 6).map((c) => (
                      <div key={c.id} className="truncate">第 {c.chapterIndex} 章 · {c.name}{c.errorMsg ? ` — ${c.errorMsg}` : ''}</div>
                    ))}
                    {failedChapters.length > 6 && <div className="text-muted">…等共 {failedChapters.length} 处</div>}
                  </div>
                  <button onClick={() => void handleExtract()} className="mini">继续提取（重试失败处）</button>
                </div>
              )}

              {llmReadiness.ok && (
                <p className="text-xs text-muted leading-relaxed">
                  DNA 将自动在后台按体量提取，无需手动操作；完成后会通知你。若长时间无进展，可在上方修复切分或检查模型配置。
                </p>
              )}

              <div className="flex gap-6 text-xs text-muted border-t border-default pt-4">
                <span>已分析: {chapters.filter((c) => c.mapStatus === 'done').length} 章</span>
                <span>短章 (&lt;500字): {chapters.filter((c) => c.wordCount < 500).length} 章</span>
                <span>长章 (&gt;12000字): {chapters.filter((c) => c.wordCount > 12000).length} 章</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-[9px] border p-3 text-xs max-w-xl flex items-start gap-2" style={{ borderColor: 'var(--del)', background: 'var(--del-soft)', color: 'var(--del)' }}>
          <span>⚠</span><p className="flex-1 leading-relaxed">{error}</p>
        </div>
      )}

      {savedToast && (
        <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs shadow-2xl" style={{ borderColor: 'var(--add)', background: 'var(--ink-raise)', color: 'var(--add)' }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--add)' }} />
          {savedToast}
        </div>
      )}
    </div>
  );
}
