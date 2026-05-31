'use client';

import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clock3,
  Loader2,
  Pause,
  Pencil,
  ScanSearch,
  Scissors,
  Search,
  Sparkles,
  Zap,
} from 'lucide-react';
import { db, type NovelDNACard } from '../app/db';
import { useAppStore } from '../app/store';
import { ensureLlmConfigReady } from '../app/llmClient';
import { runDnaExtraction } from '../app/dnaEngine';
import { getLlmReadinessSummary, getNovelWorkflowSummary } from '../app/workflow';

const DNA_FIELDS: { key: keyof NovelDNACard; label: string; helper: string }[] = [
  { key: 'theme', label: '母题与冲突', helper: '作品真正反复推进的核心矛盾。' },
  { key: 'worldview', label: '世界观规则与代价', helper: '世界如何运作、代价如何被支付。' },
  { key: 'characters', label: '角色灵魂原型', helper: '关键人物的欲望、缺陷和关系骨架。' },
  { key: 'narrativeStyle', label: '叙事结构特征', helper: '节奏、章节组织和推进手法。' },
  { key: 'styleFingerprint', label: '风格指纹', helper: '语言、情绪、镜头感与独特笔触。' },
];

const MAP_DOT: Record<string, string> = {
  pending: 'bg-zinc-600',
  done: 'bg-emerald-400',
  error: 'bg-rose-400',
};

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count.toLocaleString()} 字`;
}

export default function NovelDetail({ novelId }: { novelId: string }) {
  const { llmConfig, setManageMode, setWorkshopOpen } = useAppStore((state) => ({
    llmConfig: state.llmConfig,
    setManageMode: state.setManageMode,
    setWorkshopOpen: state.setWorkshopOpen,
  }));

  const novel = useLiveQuery(() => db.novels.get(novelId), [novelId]);
  const chapters =
    useLiveQuery(() => db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex'), [novelId]) || [];
  const readyNovelCount =
    useLiveQuery(
      () =>
        db.novels
          .filter((item) => item.analysisStatus === 'done' && Boolean(item.dnaCard))
          .count(),
      []
    ) || 0;

  const [search, setSearch] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<keyof NovelDNACard | null>(null);
  const [draft, setDraft] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  if (!novel) {
    return <div className="flex flex-1 items-center justify-center text-zinc-500 text-sm">加载中…</div>;
  }

  const llmReadiness = getLlmReadinessSummary(llmConfig);
  const workflow = getNovelWorkflowSummary(novel, llmConfig, readyNovelCount);
  const filtered = chapters.filter((chapter) => chapter.name.toLowerCase().includes(search.trim().toLowerCase()));
  const progress = novel.mapProgress || { total: 0, current: 0 };
  const status = novel.analysisStatus;
  const busy = extracting || status === 'mapping' || status === 'reducing';
  const dnaReady = status === 'done' && novel.dnaCard;
  const completedChapters = chapters.filter((chapter) => chapter.mapStatus === 'done').length;
  const errorChapters = chapters.filter((chapter) => chapter.mapStatus === 'error').length;
  const shortChapters = chapters.filter((chapter) => chapter.wordCount < 500).length;
  const longChapters = chapters.filter((chapter) => chapter.wordCount > 12000).length;

  const blocked = workflow.stages.find((stage) => stage.status === 'blocked');
  const ready = workflow.stages.find((stage) => stage.status === 'ready');
  const nextReason = blocked?.hint || ready?.hint || '当前链路畅通，可以继续进入下一阶段。';

  const handleExtract = async (limit?: number) => {
    const readiness = ensureLlmConfigReady(llmConfig);
    if (!readiness.ok) {
      window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }));
      return;
    }
    setError(null);
    setExtracting(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runDnaExtraction(novelId, { limit, signal: controller.signal });
    } catch (err) {
      setError(err instanceof Error ? err.message : '提取失败，请重试。');
    } finally {
      setExtracting(false);
      abortRef.current = null;
    }
  };

  const pause = () => abortRef.current?.abort();

  const saveField = async (key: keyof NovelDNACard) => {
    if (!novel.dnaCard) return;
    await db.novels.update(novelId, { dnaCard: { ...novel.dnaCard, [key]: draft } });
    setEditKey(null);
  };

  return (
    <div className="flex flex-1 flex-col gap-5 animate-fade-in">
      <div className="grid gap-5 xl:grid-cols-[1.7fr_1fr]">
        <div className="glass-card rounded-[28px] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-[11px] uppercase tracking-[0.26em] text-zinc-500">作品详情 / 创作 DNA</p>
              <h1 className="mt-3 text-3xl font-semibold text-zinc-50">{novel.name}</h1>
              <p className="mt-3 text-base leading-7 text-zinc-300">
                “创作 DNA” 是这部作品的题材、角色、世界观、结构与风格摘要。完成这一层后，它才会成为后续融合变体阶段的可用输入资产。
              </p>
            </div>

            <button
              onClick={() => setManageMode(true)}
              className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-zinc-100 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
            >
              <span className="flex items-center gap-2">
                <Scissors className="h-4 w-4 text-cyan-200" />
                前往切分校验台
              </span>
            </button>
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-4">
            <div className="linear-card rounded-2xl p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">作品体量</p>
              <p className="mt-3 text-2xl font-semibold text-zinc-100">{formatWordCount(novel.wordCount)}</p>
            </div>
            <div className="linear-card rounded-2xl p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">章节数</p>
              <p className="mt-3 text-2xl font-semibold text-zinc-100">{chapters.length}</p>
            </div>
            <div className="linear-card rounded-2xl p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">当前阶段</p>
              <p className="mt-3 text-2xl font-semibold text-amber-100">{workflow.recommendedNextStep}</p>
            </div>
            <div className="linear-card rounded-2xl p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">主要异常</p>
              <p className="mt-3 text-2xl font-semibold text-zinc-100">
                {novel.splitStatus === 'needs_review' ? '待校验' : errorChapters > 0 ? `${errorChapters} 章出错` : '无'}
              </p>
            </div>
          </div>
        </div>

        <div className="linear-card rounded-[28px] p-5">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">为什么下一步是这个</p>
          <h2 className="mt-3 text-xl font-semibold text-zinc-50">{workflow.recommendedNextStep}</h2>
          <p className="mt-3 text-sm leading-7 text-zinc-400">{nextReason}</p>

          <div className="mt-5 space-y-3 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between text-sm text-zinc-400">
              <span>模型状态</span>
              <span className={llmReadiness.ok ? 'text-cyan-100' : 'text-amber-200'}>
                {llmReadiness.ok ? '已就绪' : llmReadiness.reason}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm text-zinc-400">
              <span>切分质量</span>
              <span className={novel.splitStatus === 'needs_review' ? 'text-rose-200' : 'text-emerald-200'}>
                {novel.splitStatus === 'needs_review' ? '建议先修复' : '可以继续'}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm text-zinc-400">
              <span>已完成章节摘要</span>
              <span className="text-zinc-100">
                {completedChapters}/{chapters.length}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-5 xl:grid-cols-[1.65fr_0.9fr]">
        <div className="glass-card rounded-[28px] p-6">
          {!dnaReady ? (
            <div className="flex h-full flex-col gap-5">
              {!llmReadiness.ok && (
                <div className="rounded-3xl border border-amber-400/20 bg-amber-400/10 p-5">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/80">工坊启动前置条件</p>
                  <h3 className="mt-3 text-lg font-semibold text-amber-50">还差一步：先点亮模型引擎</h3>
                  <p className="mt-2 text-sm leading-7 text-amber-100/85">
                    当前还不能开始 DNA 提取，因为 {llmReadiness.reason}。配置完成后会直接回到本页继续当前任务。
                  </p>
                  <button
                    onClick={() =>
                      window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }))
                    }
                    className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-2.5 text-sm font-medium text-amber-50 transition-linear hover:bg-amber-300/16"
                  >
                    现在去配置模型
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              )}

              <div className="dna-breathe linear-card rounded-[28px] p-6">
                <div className="flex items-start gap-4">
                  <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3 text-amber-100">
                    <Sparkles className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">阶段任务卡</p>
                    <h3 className="mt-2 text-2xl font-semibold text-zinc-50">把这部作品炼成可复用的创作 DNA</h3>
                    <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-400">
                      这一步会把整本书拆成可继续创作的骨架摘要。完成后，你不仅能回看结构与角色，还能把它带进融合变体阶段，与其他作品一起生成新方向。
                    </p>
                  </div>
                </div>

                <div className="mt-6 grid gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">输入</p>
                    <p className="mt-2 text-sm leading-6 text-zinc-200">可信的章节结构与已清洗的原文内容。</p>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">处理</p>
                    <p className="mt-2 text-sm leading-6 text-zinc-200">逐章映射题材、角色、结构与风格线索，再做全书收束。</p>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">输出</p>
                    <p className="mt-2 text-sm leading-6 text-zinc-200">一份可进入变体阶段的创作骨架。</p>
                  </div>
                  <div className="rounded-2xl border border-amber-300/15 bg-amber-300/8 p-4">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/75">下一步</p>
                    <p className="mt-2 text-sm leading-6 text-amber-50">
                      {readyNovelCount > 1 ? 'DNA 完成后进入融合变体。' : 'DNA 完成后，再补齐另一部作品的 DNA。'}
                    </p>
                  </div>
                </div>

                {busy ? (
                  <div className="mt-8 rounded-3xl border border-amber-400/15 bg-amber-400/8 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/70">当前正在处理</p>
                        <h4 className="mt-2 text-lg font-semibold text-amber-50">
                          {status === 'reducing' ? '正在收束整本作品的 DNA' : '正在逐章映射创作线索'}
                        </h4>
                        <p className="mt-2 text-sm leading-6 text-amber-100/75">
                          已完成 {progress.current}/{progress.total || chapters.length} 章。
                          你可以暂停，稍后继续，不会丢失已完成的章节摘要。
                        </p>
                      </div>

                      <button
                        onClick={pause}
                        className="rounded-2xl border border-white/10 bg-white/[0.08] px-4 py-2 text-sm font-medium text-zinc-100 transition-linear hover:bg-white/[0.12]"
                      >
                        <span className="flex items-center gap-2">
                          <Pause className="h-4 w-4" />
                          暂停处理
                        </span>
                      </button>
                    </div>

                    <div className="mt-5 h-2 rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-300 via-amber-400 to-cyan-300"
                        style={{
                          width: `${progress.total ? (progress.current / progress.total) * 100 : status === 'reducing' ? 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="mt-8 grid gap-4 lg:grid-cols-2">
                    <button
                      onClick={() => handleExtract(100)}
                      className="rounded-3xl border border-cyan-400/20 bg-cyan-400/10 p-5 text-left transition-linear hover:-translate-y-0.5 hover:border-cyan-300/30"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/14 p-3 text-cyan-100">
                          <Zap className="h-5 w-5" />
                        </div>
                        <span className="rounded-full border border-cyan-300/20 px-2.5 py-1 text-[11px] text-cyan-100">推荐先跑</span>
                      </div>
                      <h4 className="mt-4 text-lg font-semibold text-zinc-50">
                        {status === 'error' ? '继续快速提取' : '快速预览提取'}
                      </h4>
                      <p className="mt-2 text-sm leading-6 text-zinc-300">
                        先提取前 100 章，快速建立题材、角色与结构轮廓。适合第一次判断这部作品的创作 DNA 是否可用。
                      </p>
                      <div className="mt-4 flex items-center gap-4 text-xs text-zinc-400">
                        <span className="flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />更快出结果</span>
                        <span>适合先看轮廓</span>
                      </div>
                    </button>

                    <button
                      onClick={() => handleExtract(undefined)}
                      className="rounded-3xl border border-amber-400/18 bg-amber-400/8 p-5 text-left transition-linear hover:-translate-y-0.5 hover:border-amber-300/28"
                    >
                      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/12 p-3 text-amber-100 w-fit">
                        <BookOpen className="h-5 w-5" />
                      </div>
                      <h4 className="mt-4 text-lg font-semibold text-zinc-50">完整提取，用于最终融合</h4>
                      <p className="mt-2 text-sm leading-6 text-zinc-300">
                        对全书进行完整的 Map-Reduce，得到更稳定的创作 DNA。适合准备进入多作品融合或需要长期沉淀这本书的摘要。
                      </p>
                      <div className="mt-4 flex items-center gap-4 text-xs text-zinc-400">
                        <span className="flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />耗时更长</span>
                        <span>适合最终结果</span>
                      </div>
                    </button>
                  </div>
                )}

                {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="linear-card rounded-2xl p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">已完成摘要</p>
                  <p className="mt-3 text-2xl font-semibold text-zinc-50">{completedChapters}</p>
                  <p className="mt-1 text-sm text-zinc-400">逐章映射已落地的章节数量。</p>
                </div>
                <div className="linear-card rounded-2xl p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">异常短章</p>
                  <p className="mt-3 text-2xl font-semibold text-amber-100">{shortChapters}</p>
                  <p className="mt-1 text-sm text-zinc-400">可能是插图、后记或切分异常的候选。</p>
                </div>
                <div className="linear-card rounded-2xl p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">超长章节</p>
                  <p className="mt-3 text-2xl font-semibold text-cyan-100">{longChapters}</p>
                  <p className="mt-1 text-sm text-zinc-400">如果明显偏多，建议先去切分校验台复核。</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col gap-5">
              <div className="flex items-start justify-between gap-4 rounded-[28px] border border-emerald-400/18 bg-emerald-400/8 p-6">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-100/75">阶段完成</p>
                  <h3 className="mt-2 text-2xl font-semibold text-zinc-50">这部作品的创作 DNA 已经点亮</h3>
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-300">
                    你现在已经拿到了可进入变体阶段的创作骨架。下一步不是回到工具列表，而是判断变体准入是否满足，然后继续生成新方向。
                  </p>
                </div>
                {readyNovelCount > 1 ? (
                  <button
                    onClick={() => setWorkshopOpen(true)}
                    className="rounded-2xl border border-amber-300/25 bg-amber-300/14 px-4 py-3 text-sm font-medium text-amber-50 transition-linear hover:bg-amber-300/18"
                  >
                    <span className="flex items-center gap-2">
                      进入融合变体
                      <ArrowRight className="h-4 w-4" />
                    </span>
                  </button>
                ) : (
                  <div className="rounded-2xl border border-rose-300/18 bg-rose-300/10 px-4 py-3 text-sm leading-6 text-rose-100">
                    变体阶段仍受阻：当前只有 {readyNovelCount} 部 DNA 就绪作品。至少两部作品完成 DNA，才有足够的碰撞素材。
                  </div>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <div className="linear-card rounded-2xl p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">当前产物</p>
                  <p className="mt-3 text-lg font-semibold text-emerald-200">创作 DNA 已就绪</p>
                </div>
                <div className="linear-card rounded-2xl p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">变体准入</p>
                  <p className="mt-3 text-lg font-semibold text-zinc-100">{readyNovelCount}/2 部 DNA</p>
                </div>
                <div className="linear-card rounded-2xl p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">完成后可得</p>
                  <p className="mt-3 text-sm leading-6 text-zinc-200">方向卡、故事板与正文变体草案。</p>
                </div>
                <div className="linear-card rounded-2xl p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">唯一下一步</p>
                  <p className="mt-3 text-sm leading-6 text-amber-100">
                    {readyNovelCount > 1 ? '进入融合变体阶段。' : '再完成一部作品的 DNA。'}
                  </p>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {DNA_FIELDS.map(({ key, label, helper }) => (
                  <div key={key} className="group linear-card rounded-3xl p-5 transition-linear">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/75">{label}</p>
                        <p className="mt-2 text-sm leading-6 text-zinc-500">{helper}</p>
                      </div>
                      {editKey === key ? (
                        <button onClick={() => saveField(key)} className="text-emerald-300 hover:text-emerald-200" title="保存">
                          <Check className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setEditKey(key);
                            setDraft(novel.dnaCard?.[key] ?? '');
                          }}
                          className="rounded-full border border-white/10 p-2 text-zinc-500 transition-linear hover:border-amber-300/25 hover:text-amber-100"
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      )}
                    </div>

                    {editKey === key ? (
                      <textarea
                        autoFocus
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        rows={7}
                        className="mt-4 w-full rounded-2xl border border-amber-400/18 bg-[#0a1018] p-3 text-sm leading-7 text-zinc-100 focus:outline-none resize-y"
                      />
                    ) : (
                      <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-zinc-200">{novel.dnaCard?.[key]}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-col gap-5">
          <div className="linear-card flex min-h-[460px] flex-1 flex-col rounded-[28px] overflow-hidden">
            <div className="linear-border-b p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">章节预览面板</p>
                  <h3 className="mt-2 text-lg font-semibold text-zinc-50">快速检查作品切分与进度</h3>
                </div>
                <div className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-zinc-400">
                  {chapters.length} 章
                </div>
              </div>

              <div className="relative mt-4">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索章节标题、序章、后记…"
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.03] py-3 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              <div className="space-y-2">
                {filtered.slice(0, 80).map((chapter) => (
                  <div key={chapter.id} className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3">
                    <div className="flex items-start gap-3">
                      {chapter.mapStatus === 'mapping' ? (
                        <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-amber-200" />
                      ) : (
                        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${MAP_DOT[chapter.mapStatus] || 'bg-zinc-600'}`} />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-100">{chapter.name}</p>
                        <p className="mt-1 text-xs text-zinc-500">{chapter.wordCount.toLocaleString()} 字</p>
                      </div>
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-zinc-500">
                    没有找到匹配章节，试试换个关键词。
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="linear-card rounded-[28px] p-5">
            <div className="flex items-center gap-2 text-zinc-100">
              <ScanSearch className="h-4 w-4 text-cyan-200" />
              <h4 className="text-sm font-semibold">继续这条心流的原因</h4>
            </div>
            <p className="mt-3 text-sm leading-7 text-zinc-400">
              先把单本作品的骨架提炼清楚，后面的变体阶段才不会变成“只是在拼素材”。如果你看到很多短章、插图或异常章节，先去切分校验台处理，再继续这一步会更稳。
            </p>
            {dnaReady && (
              <div className="mt-4 flex items-center gap-2 rounded-2xl border border-emerald-400/18 bg-emerald-400/8 px-4 py-3 text-sm text-emerald-100">
                <CheckCircle2 className="h-4 w-4" />
                当前作品已经具备成为变体输入资产的资格。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
