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
  pending: 'bg-zinc-800 border-zinc-700',
  done: 'bg-emerald-500 shadow-[0_0_6px_#10b981]',
  error: 'bg-rose-500 shadow-[0_0_6px_#f43f5e]',
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
  const [showChapters, setShowChapters] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  if (!novel) {
    return <div className="flex flex-1 items-center justify-center text-zinc-600 text-xs font-mono">LOADING_PROJECT...</div>;
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
  const nextReason = blocked?.hint || ready?.hint || '上游轨道畅通，可推进当前 DNA 提炼任务。';

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
      setError(err instanceof Error ? err.message : '提炼失败，请核实引擎状态并重试。');
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
    <div className="flex flex-1 flex-col gap-5 animate-fade-in bg-[#000000]">
      <div className="grid gap-5 xl:grid-cols-[1.7fr_1fr]">
        <div className="glass-card rounded-xl p-6 border-white/5 bg-zinc-950/60">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-[10px] font-mono tracking-widest text-zinc-500 uppercase">原稿管理 / 提炼工作台</p>
              <h1 className="mt-2 text-2xl font-semibold text-zinc-100 tracking-tight">{novel.name}</h1>
              <p className="mt-2.5 text-xs leading-relaxed text-zinc-400">
                “创作 DNA” 是利用 Map-Reduce 框架逐章分析并汇总所得的世界观、母题、角色骨架与文风线索。
                DNA 提取完毕后，本小说项目将自动沉淀为可参与创意变体融合的数字资产。
              </p>
            </div>

            <button
              onClick={() => setManageMode(true)}
              className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs font-medium text-zinc-300 transition-linear hover:border-white/20 hover:bg-white/[0.04]"
            >
              <span className="flex items-center gap-2">
                <Scissors className="h-3.5 w-3.5 text-zinc-400" />
                返回切分校验台
              </span>
            </button>
          </div>

          <div className="mt-6 grid gap-3 grid-cols-2 md:grid-cols-4 font-mono">
            <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
              <p className="text-[9px] tracking-wider text-zinc-650 uppercase">项目总字数</p>
              <p className="mt-2 text-base font-semibold text-zinc-300">{formatWordCount(novel.wordCount)}</p>
            </div>
            <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
              <p className="text-[9px] tracking-wider text-zinc-650 uppercase">总章节数</p>
              <p className="mt-2 text-base font-semibold text-zinc-300">{chapters.length}</p>
            </div>
            <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
              <p className="text-[9px] tracking-wider text-zinc-650 uppercase">推荐行动</p>
              <p className="mt-2 text-xs font-sans font-medium text-zinc-200 truncate">{workflow.recommendedNextStep}</p>
            </div>
            <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
              <p className="text-[9px] tracking-wider text-zinc-650 uppercase">校验健康度</p>
              <p className="mt-2 text-base font-semibold text-zinc-300">
                {novel.splitStatus === 'needs_review' ? '待修正' : errorChapters > 0 ? '存疑' : '正常'}
              </p>
            </div>
          </div>
        </div>

        <div className="linear-card rounded-xl p-5 border-white/5 bg-zinc-950/20">
          <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">任务决策线索</p>
          <h2 className="mt-2 text-sm font-semibold text-zinc-200">{workflow.recommendedNextStep}</h2>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">{nextReason}</p>

          <div className="mt-5 space-y-2.5 rounded-xl border border-white/5 bg-white/[0.01] p-4 text-xs font-mono">
            <div className="flex items-center justify-between text-zinc-500">
              <span>模型接口密钥</span>
              <span className="flex items-center gap-1.5 text-zinc-400">
                <span className={`h-1.5 w-1.5 rounded-full ${llmReadiness.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                {llmReadiness.ok ? 'OK' : 'OFFLINE'}
              </span>
            </div>
            <div className="flex items-center justify-between text-zinc-500">
              <span>章节划分品质</span>
              <span className="flex items-center gap-1.5 text-zinc-400">
                <span className={`h-1.5 w-1.5 rounded-full ${novel.splitStatus === 'needs_review' ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`} />
                {novel.splitStatus === 'needs_review' ? '待校验异常' : '完好'}
              </span>
            </div>
            <div className="flex items-center justify-between text-zinc-500">
              <span>章节摘要进度</span>
              <span className="text-zinc-300">
                {completedChapters} / {chapters.length} 章
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className={`grid min-h-0 flex-1 gap-5 ${dnaReady && !showChapters ? 'grid-cols-1' : 'xl:grid-cols-[1.65fr_0.9fr]'}`}>
        <div className="glass-card rounded-xl p-6 border-hairline bg-surface-1">
          {!dnaReady ? (
            <div className="flex h-full flex-col gap-5">
              {!llmReadiness.ok && (
                <div className="rounded-xl border border-white/5 bg-zinc-950/40 p-5">
                  <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">工坊前置硬阻碍</p>
                  <h3 className="mt-2.5 text-sm font-semibold text-zinc-200">引擎未点亮，模型密钥待配置</h3>
                  <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                    当前大模型引擎未启用（{llmReadiness.reason}）。请首先点击下方前去启动面板配置 Base URL 和接口 Key。
                  </p>
                  <button
                    onClick={() =>
                      window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }))
                    }
                    className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2 text-xs font-semibold text-zinc-300 transition-linear hover:bg-white/[0.04]"
                  >
                    前去模型配置面板
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <div className="dna-breathe linear-card rounded-xl p-6 bg-zinc-950/20 border-white/5">
                <div className="flex items-start gap-4">
                  <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5 text-zinc-200">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-[10px] font-mono tracking-widest text-zinc-500 uppercase">提取控制卡</p>
                    <h3 className="mt-1 text-base font-semibold text-zinc-200">提炼小说创作 DNA 线索</h3>
                    <p className="mt-2.5 max-w-3xl text-xs leading-relaxed text-zinc-500">
                      通过 LLM 对所有章节进行 Map-Reduce：首轮抽取每章节的母题冲突、角色映射；第二轮将章节汇总收束为一幅包含五大维度的创作骨架名片。提炼完毕即可解锁创意融合。
                    </p>
                  </div>
                </div>

                <div className="mt-6 grid gap-3 md:grid-cols-4 text-xs leading-relaxed text-zinc-500">
                  <div className="rounded-xl border border-white/5 bg-white/[0.01] p-4">
                    <p className="text-[9px] font-mono tracking-wider text-zinc-500 uppercase">项目输入</p>
                    <p className="mt-1 text-zinc-400">已校验的章节原稿结构全文。</p>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-white/[0.01] p-4">
                    <p className="text-[9px] font-mono tracking-wider text-zinc-500 uppercase">模型拟合</p>
                    <p className="mt-1 text-zinc-400">逐章抽取题材与笔触特征，最终全书降维收束。</p>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-white/[0.01] p-4">
                    <p className="text-[9px] font-mono tracking-wider text-zinc-500 uppercase">提炼成果</p>
                    <p className="mt-1 text-zinc-400">一份标准数字化的创作 DNA 看板。</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                    <p className="text-[9px] font-mono tracking-wider text-zinc-400 uppercase">工作流依赖</p>
                    <p className="mt-1 text-zinc-200">
                      {readyNovelCount > 1 ? 'DNA 完成后立即可融合。' : '还需提炼另一本以凑齐碰撞对。'}
                    </p>
                  </div>
                </div>

                {busy ? (
                  <div className="mt-8 rounded-xl border border-white/5 bg-zinc-950/40 p-5">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between text-xs text-zinc-450 font-mono">
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                          {status === 'reducing' ? '汇总收束整本 DNA 骨架中' : `逐章映射中 (${progress.current}/${progress.total || chapters.length})`}
                        </span>
                        <button
                          onClick={pause}
                          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-white/[0.06] transition-linear active-press"
                        >
                          <Pause className="h-3 w-3" />
                          暂停
                        </button>
                      </div>

                      {/* Geist Style Precise Progress Line (2px) */}
                      <div className="h-[2px] w-full bg-zinc-900 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-white transition-all duration-300"
                          style={{
                            width: `${progress.total ? (progress.current / progress.total) * 100 : status === 'reducing' ? 100 : 0}%`,
                          }}
                        />
                      </div>

                      <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                        <span>MAP_REDUCE_PIPELINE</span>
                        <span>{progress.total ? Math.round((progress.current / progress.total) * 100) : status === 'reducing' ? 100 : 0}%</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-8 grid gap-4 lg:grid-cols-2">
                    <button
                      onClick={() => handleExtract(100)}
                      className="rounded-xl border border-hairline bg-white/[0.01] p-5 text-left transition-linear hover:border-white/15 hover:bg-white/[0.02]"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="rounded-xl border border-white/5 bg-white/[0.015] p-2.5 text-zinc-300">
                          <Zap className="h-4 w-4" />
                        </div>
                        <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[9px] font-mono text-zinc-400">RECOMMENDED</span>
                      </div>
                      <h4 className="mt-4 text-sm font-semibold text-zinc-200">
                        {status === 'error' ? '继续快速提取' : '快速提取 (前 100 章)'}
                      </h4>
                      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                        快速拟合前 100 章。适合大体量小说快速建模、预览 DNA 粗坯，耗时显著缩短。
                      </p>
                      <div className="mt-4 flex items-center gap-4 text-[10px] text-zinc-650 font-mono">
                        <span className="flex items-center gap-1"><Clock3 className="h-3 w-3" />EST_SHORT</span>
                        <span>PREVIEW_MODE</span>
                      </div>
                    </button>

                    <button
                      onClick={() => handleExtract(undefined)}
                      className="rounded-xl border border-hairline bg-white/[0.01] p-5 text-left transition-linear hover:border-white/15 hover:bg-white/[0.02]"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="rounded-xl border border-white/5 bg-white/[0.015] p-2.5 text-zinc-300">
                          <BookOpen className="h-4 w-4" />
                        </div>
                        <span className="rounded-full border border-white/5 px-2.5 py-0.5 text-[9px] font-mono text-zinc-650">DEEP_RUN</span>
                      </div>
                      <h4 className="mt-4 text-sm font-semibold text-zinc-200">深度全量提取 (最终融合依赖)</h4>
                      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                        对全书章节做全量级分析归纳。适合获取最终成熟的 DNA 板块资产，提炼品质极高。
                      </p>
                      <div className="mt-4 flex items-center gap-4 text-[10px] text-zinc-650 font-mono">
                        <span className="flex items-center gap-1"><Clock3 className="h-3 w-3" />EST_LONG</span>
                        <span>PRODUCTION_MODE</span>
                      </div>
                    </button>
                  </div>
                )}

                {error && <p className="mt-4 text-xs font-mono text-rose-400">{error}</p>}
              </div>

              <div className="grid gap-3 grid-cols-3 font-mono text-xs">
                <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
                  <p className="text-[9px] tracking-wider text-zinc-600 uppercase">已完成章节摘要</p>
                  <p className="mt-2.5 text-lg font-semibold text-zinc-300">{completedChapters}</p>
                </div>
                <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
                  <p className="text-[9px] tracking-wider text-zinc-600 uppercase">异常超短章节</p>
                  <p className="mt-2.5 text-lg font-semibold text-zinc-300">{shortChapters}</p>
                </div>
                <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
                  <p className="text-[9px] tracking-wider text-zinc-600 uppercase">异常超长章节</p>
                  <p className="mt-2.5 text-lg font-semibold text-zinc-300">{longChapters}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col gap-5">
              <div className="flex items-start justify-between gap-4 rounded-xl border border-hairline bg-zinc-950/40 p-6">
                <div>
                  <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">STAGE_COMPLETED</p>
                  <h3 className="mt-1 text-base font-semibold text-zinc-200">《{novel.name}》的创作 DNA 已成功点亮</h3>
                  <p className="mt-2.5 max-w-3xl text-xs leading-relaxed text-zinc-500">
                    本原稿已完成自适应的 Map-Reduce 创作骨架提炼。您可以往下直接查看/精调各项设定，也可以立即进入变体融合工坊。
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => setShowChapters((prev) => !prev)}
                    className="rounded-md border border-hairline bg-surface-2 px-4 py-2.5 text-xs font-medium text-zinc-300 transition-linear hover:bg-surface-3 active-press"
                  >
                    {showChapters ? '隐藏原稿章节' : '查看原稿章节'}
                  </button>
                  {readyNovelCount > 1 ? (
                    <button
                      onClick={() => setWorkshopOpen(true)}
                      className="rounded-md bg-primary hover:bg-primary-hover active:bg-primary-focus px-4 py-2.5 text-xs font-semibold text-white transition-linear active-press shadow-[0_0_8px_rgba(94,106,210,0.3)]"
                    >
                      <span className="flex items-center gap-2">
                        进入融合工坊
                        <ArrowRight className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  ) : (
                    <div className="rounded-md border border-hairline bg-white/[0.01] px-4 py-3 text-xs leading-relaxed text-zinc-500 max-w-xs">
                      碰撞准备阻断：目前仅有 {readyNovelCount} 本 DNA 就绪作品。至少两本 DNA 就绪，才能进入创意融合。
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-3 grid-cols-2 md:grid-cols-4 font-mono text-xs">
                <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
                  <p className="text-[9px] tracking-wider text-zinc-650 uppercase">当前状况</p>
                  <p className="mt-2 text-sm font-sans font-semibold text-emerald-400">DNA 已就绪</p>
                </div>
                <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
                  <p className="text-[9px] tracking-wider text-zinc-650 uppercase">变体备用素材数</p>
                  <p className="mt-2 text-sm font-semibold text-zinc-300">{readyNovelCount} / 2 部</p>
                </div>
                <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
                  <p className="text-[9px] tracking-wider text-zinc-650 uppercase">已完成汇总项</p>
                  <p className="mt-2 text-sm font-semibold text-zinc-350">5 大骨架维度</p>
                </div>
                <div className="linear-card rounded-xl p-4 bg-zinc-950/20 border-white/5">
                  <p className="text-[9px] tracking-wider text-zinc-650 uppercase">下一步指引</p>
                  <p className="mt-2 text-xs font-sans text-zinc-400">
                    {readyNovelCount > 1 ? '前去变体工坊' : '补齐第二部 DNA'}
                  </p>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {DNA_FIELDS.map(({ key, label, helper }) => (
                  <div key={key} className="group linear-card rounded-xl p-5 bg-zinc-950/20 border-white/5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">{label}</p>
                        <p className="mt-1 text-xs text-zinc-600">{helper}</p>
                      </div>
                      {editKey === key ? (
                        <button onClick={() => saveField(key)} className="text-zinc-200 hover:text-white transition-linear" title="保存">
                          <Check className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setEditKey(key);
                            setDraft(novel.dnaCard?.[key] ?? '');
                          }}
                          className="rounded-full border border-white/5 p-1.5 text-zinc-600 opacity-0 group-hover:opacity-100 transition-linear hover:border-white/15 hover:text-zinc-200"
                          title="编辑修改"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    {editKey === key ? (
                      <textarea
                        autoFocus
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        rows={7}
                        className="mt-4 w-full rounded-xl border border-white/10 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/10 resize-y font-mono"
                      />
                    ) : (
                      <p className="mt-4 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400 font-serif">{novel.dnaCard?.[key]}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {(!dnaReady || showChapters) && (
          <div className="flex min-h-0 flex-col gap-5">
            <div className="linear-card flex min-h-[460px] flex-1 flex-col rounded-xl overflow-hidden border-hairline bg-zinc-950/20">
            <div className="linear-border-b p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase">项目校验状态</p>
                  <h3 className="mt-1 text-xs font-semibold text-zinc-200">原稿章节初筛与摘要状态表</h3>
                </div>
                <div className="rounded-full border border-white/5 bg-white/[0.01] px-2 py-0.5 text-[10px] font-mono text-zinc-500">
                  {chapters.length} CHS
                </div>
              </div>

              <div className="relative mt-4">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="检索特定的章节名称或字眼..."
                  className="w-full rounded-xl border border-white/5 bg-zinc-950 py-2.5 pl-10 pr-4 text-xs text-zinc-200 placeholder:text-zinc-655 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              <div className="space-y-2">
                {filtered.slice(0, 80).map((chapter) => (
                  <div key={chapter.id} className="rounded-xl border border-white/5 bg-white/[0.01] px-4 py-2.5">
                    <div className="flex items-start gap-3 justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-zinc-300">{chapter.name}</p>
                        <p className="mt-1 text-[10px] text-zinc-600 font-mono">{chapter.wordCount.toLocaleString()} 字</p>
                      </div>
                      {chapter.mapStatus === 'mapping' ? (
                        <div className="linear-loader-container rounded-full w-[24px] mt-2">
                          <div className="linear-loader-bar rounded-full" />
                        </div>
                      ) : (
                        <span
                          title={chapter.mapStatus === 'done' ? 'DNA 已点亮就绪' : chapter.mapStatus === 'error' ? '提取发生故障' : '等待 DNA 提取'}
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full border ${MAP_DOT[chapter.mapStatus] || 'bg-zinc-800'}`}
                        />
                      )}
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/5 bg-white/[0.01] px-4 py-8 text-center text-xs text-zinc-600">
                    未查到符合过滤项的章节。
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="linear-card rounded-xl p-5 border-white/5 bg-zinc-950/20">
            <div className="flex items-center gap-2 text-zinc-400">
              <ScanSearch className="h-3.5 w-3.5 text-zinc-300" />
              <h4 className="text-xs font-semibold">提取心流保障 (SAFEGUARD)</h4>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              单篇原稿提取是构建高可控创意碰撞的刚性基石。如果章节存在严重的乱码断章、插图误识别，强烈建议前去校验台利用正则对其重置，防止提取阶段的特征被稀释。
            </p>
            {dnaReady && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-hairline bg-white/[0.01] px-4 py-3 text-xs text-zinc-400">
                <CheckCircle2 className="h-4 w-4 text-zinc-400" />
                已锁定当前项目的数字特征，具备融合工坊输入许可。
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  </div>
  );
}
