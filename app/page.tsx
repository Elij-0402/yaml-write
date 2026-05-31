'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BookMarked,
  Bot,
  ChevronRight,
  Compass,
  FilePlus2,
  Layers,
  Orbit,
  ScanSearch,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { db, type Novel } from './db';
import { useAppStore } from './store';
import NovelUploader from '../components/NovelUploader';
import NovelDetail from '../components/NovelDetail';
import FusionWorkshop from '../components/FusionWorkshop';
import SettingsPanel from '../components/SettingsPanel';
import { getLlmReadinessSummary, getNovelWorkflowSummary, getStageStatusClasses } from './workflow';

type LandingMode = 'overview' | 'upload';

const PIPELINE_BLUEPRINT = [
  {
    id: 'import',
    stage: '01 导入文本',
    title: '把原文变成可推进的作品项目',
    input: 'TXT 原文与作品名',
    process: '清洗编码、净化噪音、建立项目',
    output: '作品项目已建立',
    next: '进入切分校验',
  },
  {
    id: 'split',
    stage: '02 校验切分',
    title: '确认章节结构是否可信',
    input: '已导入的章节草分结果',
    process: '检查异常短章、超长章与噪音',
    output: '章节结构可被信任',
    next: '进入 DNA 提取',
  },
  {
    id: 'dna',
    stage: '03 提取 DNA',
    title: '提炼可复用的创作骨架',
    input: '可信的章节结构',
    process: '抽取题材、角色、世界观、结构与风格',
    output: '可进入变体阶段的创作骨架',
    next: '进入融合变体',
  },
  {
    id: 'fusion',
    stage: '04 融合变体',
    title: '让多部作品产生新方向',
    input: '至少两部 DNA 就绪作品',
    process: '选择方向、打磨设定、生成故事板',
    output: '方向卡、故事板、正文变体草案',
    next: '继续扩写与迭代',
  },
] as const;

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count} 字`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function dnaBadge(novel: Novel): { text: string; cls: string } {
  if (novel.analysisStatus === 'done' && novel.dnaCard) {
    return { text: 'DNA 就绪', cls: 'text-emerald-300' };
  }
  if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') {
    const p = novel.mapProgress;
    const pct = p && p.total ? Math.round((p.current / p.total) * 100) : 0;
    return { text: `提取中 ${pct}%`, cls: 'text-amber-200' };
  }
  if (novel.splitStatus === 'needs_review') {
    return { text: '切分待校验', cls: 'text-rose-200' };
  }
  return { text: '待提取', cls: 'text-cyan-100' };
}

function WorkspaceOverview({
  novels,
  readyNovelCount,
  llmReady,
  onUpload,
  onContinue,
}: {
  novels: Novel[];
  readyNovelCount: number;
  llmReady: boolean;
  onUpload: () => void;
  onContinue: () => void;
}) {
  const latestNovel = novels[0] || null;
  const needsReviewCount = novels.filter((novel) => novel.splitStatus === 'needs_review').length;

  return (
    <div className="flex h-full flex-col gap-6 animate-fade-in">
      <div className="glass-card rounded-[28px] p-8 panel-grid">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-xs text-amber-100">
            <Sparkles className="h-3.5 w-3.5" />
            未来感创作工坊
          </div>
          <h1 className="mt-5 text-4xl font-semibold leading-tight text-zinc-50">
            把长篇原文炼成
            <span className="bg-gradient-to-r from-amber-200 via-amber-300 to-cyan-200 bg-clip-text text-transparent"> 可继续创作的 DNA 与融合方向</span>
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-300">
            这里不是简单的文本工具，而是一条清晰的创作流水线：
            导入原文、校验切分、提取题材与角色骨架，再进入多作品融合变体阶段。
          </p>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <button
            onClick={onUpload}
            className="glass-card group rounded-3xl border border-cyan-400/20 p-6 text-left transition-linear hover:-translate-y-0.5 hover:border-cyan-300/30 focus-energy"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3 text-cyan-100">
                <FilePlus2 className="h-6 w-6" />
              </div>
              <ChevronRight className="h-5 w-5 text-zinc-500 transition-linear group-hover:text-cyan-100" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-zinc-100">导入新作品</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              支持 TXT 文本、自动净化广告噪音、多编码识别，并直接进入切分校验台。
            </p>
          </button>

          <button
            onClick={onContinue}
            disabled={!latestNovel}
            className="glass-card group rounded-3xl border border-amber-400/20 p-6 text-left transition-linear hover:-translate-y-0.5 hover:border-amber-300/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3 text-amber-100">
                <Compass className="h-6 w-6" />
              </div>
              <ChevronRight className="h-5 w-5 text-zinc-500 transition-linear group-hover:text-amber-100" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-zinc-100">继续最近作品</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              {latestNovel
                ? `继续回到《${latestNovel.name}》，沿着当前阶段继续推进。`
                : '先导入第一部作品，这里会自动记住你的最近进度。'}
            </p>
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
        {PIPELINE_BLUEPRINT.map((item) => (
          <div key={item.id} className="linear-card rounded-3xl p-5">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{item.stage}</p>
            <h3 className="mt-3 text-lg font-semibold text-zinc-50">{item.title}</h3>
            <div className="mt-4 space-y-3 text-sm leading-6 text-zinc-400">
              <p><span className="text-zinc-200">输入：</span>{item.input}</p>
              <p><span className="text-zinc-200">处理：</span>{item.process}</p>
              <p><span className="text-zinc-200">输出：</span>{item.output}</p>
              <p><span className="text-amber-100">下一步：</span>{item.next}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="linear-card rounded-3xl p-5">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">作品库存</p>
          <p className="mt-4 text-3xl font-semibold text-zinc-50">{novels.length}</p>
          <p className="mt-2 text-sm text-zinc-400">库内已有可继续推进的长篇项目。</p>
        </div>
        <div className="linear-card rounded-3xl p-5">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">DNA 就绪</p>
          <p className="mt-4 text-3xl font-semibold text-emerald-200">{readyNovelCount}</p>
          <p className="mt-2 text-sm text-zinc-400">可直接进入工坊选材台的作品数量。</p>
        </div>
        <div className="linear-card rounded-3xl p-5">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">待校验异常</p>
          <p className="mt-4 text-3xl font-semibold text-rose-200">{needsReviewCount}</p>
          <p className="mt-2 text-sm text-zinc-400">切分质量仍需人工确认或修复的项目。</p>
        </div>
        <div className="linear-card rounded-3xl p-5">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">模型状态</p>
          <p className={`mt-4 text-2xl font-semibold ${llmReady ? 'text-cyan-100' : 'text-amber-200'}`}>
            {llmReady ? '已就绪' : '待启动'}
          </p>
          <p className="mt-2 text-sm text-zinc-400">
            {llmReady ? '可以直接开始 DNA 提取，并为后续变体阶段解锁输入资产。' : '请先配置大模型，DNA 与变体阶段才会点亮。'}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { selectedNovelId, setSelectedNovelId, workshopOpen, setWorkshopOpen, manageMode, setManageMode, llmConfig } =
    useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsIntent, setSettingsIntent] = useState<string | null>(null);
  const [landingMode, setLandingMode] = useState<LandingMode>('overview');

  const novels = useLiveQuery<Novel[]>(() => db.novels.orderBy('createdAt').reverse().toArray(), []) || [];
  const selectedNovel = novels.find((novel) => novel.id === selectedNovelId) || null;

  const readyNovelCount = novels.filter((novel) => novel.analysisStatus === 'done' && novel.dnaCard).length;
  const llmReadiness = useMemo(() => getLlmReadinessSummary(llmConfig), [llmConfig]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{ intent?: string }>;
      setSettingsIntent(custom.detail?.intent || null);
      setSettingsOpen(true);
    };
    window.addEventListener('open-settings-panel', handler as EventListener);
    return () => window.removeEventListener('open-settings-panel', handler as EventListener);
  }, []);

  useEffect(() => {
    if (selectedNovelId) {
      setLandingMode('overview');
      return;
    }
    setLandingMode('overview');
  }, [novels.length, selectedNovelId]);

  const deleteNovel = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (typeof window !== 'undefined' && !window.confirm('删除该小说及其全部章节？此操作不可撤销。')) return;
    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(id).delete();
      await db.novels.delete(id);
    });
    if (selectedNovelId === id) {
      setSelectedNovelId(null);
    }
  };

  const selectedSummary = getNovelWorkflowSummary(selectedNovel, llmConfig, readyNovelCount);
  const workflowStages = selectedSummary.stages;

  const headerLabel = workshopOpen
    ? '融合变体 / 多作品生成'
    : selectedNovel
    ? manageMode
      ? '切分校验台 / 修复章节'
      : '作品详情 / 创作 DNA'
    : landingMode === 'upload'
    ? '导入新作品'
    : '创作工坊总览';
  const sidebarReason = workshopOpen
    ? readyNovelCount > 1
      ? '变体阶段已经满足准入条件，接下来应直接从选材开始，而不是回到上游反复确认。'
      : '当前仍缺少足够的 DNA 资产，变体阶段会被阻塞，应该先回到上游补齐。'
    : selectedSummary.readinessReason ||
      workflowStages.find((stage) => stage.status === 'blocked' || stage.status === 'ready')?.hint ||
      '当前链路已经畅通，可以继续进入下一阶段。';
  const sidebarNextStep = workshopOpen
    ? readyNovelCount > 1
      ? '进入选材与方向生成'
      : '去补齐另一部作品的 DNA'
    : selectedSummary.recommendedNextStep;
  const sidebarCurrentStep = workshopOpen
    ? '融合变体阶段'
    : selectedNovel
    ? headerLabel
    : '导入文本阶段';

  return (
    <main className="flex min-h-screen bg-[var(--bg-app)] text-zinc-100">
      <aside className="linear-border-r hidden w-[280px] shrink-0 flex-col bg-[#06090f] lg:flex">
        <div className="linear-border-b px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-2.5 text-amber-100 energy-ring">
              <Orbit className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-zinc-50">创作 DNA 工坊</h1>
              <p className="mt-1 text-[11px] uppercase tracking-[0.28em] text-zinc-500">FUTURE STORY FOUNDRY</p>
            </div>
          </div>

          <button
            onClick={() => {
              setSelectedNovelId(null);
              setWorkshopOpen(false);
              setManageMode(false);
              setLandingMode('upload');
            }}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm font-medium text-cyan-100 transition-linear hover:border-cyan-300/30 hover:bg-cyan-400/14"
          >
            <FilePlus2 className="h-4 w-4" />
            导入新作品
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">作品项目轨道</span>
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-zinc-400">{novels.length}</span>
          </div>

          <div className="space-y-3">
            {novels.length === 0 && (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-sm leading-6 text-zinc-500">
                还没有作品。先导入一本长篇原文，工坊轨道就会开始记录你的进度。
              </div>
            )}

            {novels.map((novel) => {
              const active = !workshopOpen && selectedNovelId === novel.id;
              const badge = dnaBadge(novel);
              const workflow = getNovelWorkflowSummary(novel, llmConfig, readyNovelCount);
              return (
                <button
                  key={novel.id}
                  onClick={() => {
                    setSelectedNovelId(novel.id);
                    setLandingMode('overview');
                  }}
                  className={`group w-full rounded-3xl border p-4 text-left transition-linear ${
                    active
                      ? 'border-amber-400/30 bg-amber-400/10 shadow-[0_0_0_1px_rgba(247,165,26,0.12)]'
                      : 'border-white/8 bg-white/[0.025] hover:border-white/15 hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-100">{novel.name}</p>
                      <p className="mt-1 text-xs text-zinc-500">{formatWordCount(novel.wordCount)} · 更新于 {formatTime(novel.createdAt)}</p>
                    </div>
                    <button
                      onClick={(event) => void deleteNovel(novel.id, event)}
                      className="rounded-full border border-white/10 p-1.5 text-zinc-500 transition-linear hover:border-rose-400/30 hover:text-rose-200"
                      title="删除作品"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] ${badge.cls} bg-white/5`}>{badge.text}</span>
                    <span className="text-[11px] text-zinc-500">{workflow.recommendedNextStep}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="linear-border-t space-y-2 px-4 py-4">
          <button
            onClick={() => setWorkshopOpen(true)}
            className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-medium transition-linear ${
              workshopOpen
                ? 'border-amber-400/30 bg-amber-400/10 text-amber-100'
                : 'border-white/10 bg-white/[0.03] text-zinc-200 hover:border-white/20 hover:bg-white/[0.05]'
            }`}
          >
            <Layers className="h-4 w-4" />
            变体工坊
          </button>
          <button
            onClick={() => {
              setSettingsIntent(workshopOpen ? '融合变体' : selectedNovel ? 'DNA 提取' : '创作工坊');
              setSettingsOpen(true);
            }}
            className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-zinc-200 transition-linear hover:border-white/20 hover:bg-white/[0.05]"
          >
            <Settings className="h-4 w-4" />
            工坊启动面板
            <span className="ml-auto text-[11px] text-zinc-500">
              {llmReadiness.ok ? '已就绪' : '待配置'}
            </span>
          </button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="linear-border-b sticky top-0 z-20 bg-[#070a10]/88 backdrop-blur-xl">
          <div className="px-5 py-4 lg:px-8">
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <BookMarked className="h-3.5 w-3.5" />
                    <span>{selectedNovel ? selectedNovel.name : workshopOpen ? '变体工坊' : '总览'}</span>
                    <span>/</span>
                    <span>{workshopOpen ? '变体阶段' : selectedNovel ? '作品链路' : '流水线总览'}</span>
                    <span>/</span>
                    <span className="text-zinc-300">{headerLabel}</span>
                  </div>
                  <h2 className="mt-2 text-xl font-semibold text-zinc-50">{headerLabel}</h2>
                </div>

                <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                  <Bot className="h-3.5 w-3.5" />
                  模型状态：
                  <span className={llmReadiness.ok ? 'text-cyan-100' : 'text-amber-200'}>
                    {llmReadiness.ok ? '已就绪' : llmReadiness.reason}
                  </span>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                {workflowStages.map((stage, index) => (
                  <div key={stage.id} className={`rounded-2xl border px-4 py-3 ${getStageStatusClasses(stage.status)}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] uppercase tracking-[0.22em] text-current/65">0{index + 1}</span>
                      <span className="text-xs text-current/80">{stage.shortLabel}</span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-current">{stage.label}</p>
                    <p className="mt-1 text-xs leading-5 text-current/75">{stage.hint}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-5 lg:px-8 lg:py-6">
            {workshopOpen ? (
              <FusionWorkshop />
            ) : selectedNovelId && !manageMode ? (
              <NovelDetail novelId={selectedNovelId} />
            ) : selectedNovelId && manageMode ? (
              <NovelUploader />
            ) : landingMode === 'upload' ? (
              <NovelUploader />
            ) : (
              <WorkspaceOverview
                novels={novels}
                readyNovelCount={readyNovelCount}
                llmReady={llmReadiness.ok}
                onUpload={() => setLandingMode('upload')}
                onContinue={() => {
                  if (!novels[0]) return;
                  setSelectedNovelId(novels[0].id);
                }}
              />
            )}
          </div>

          <aside className="linear-border-l hidden w-[320px] shrink-0 overflow-y-auto bg-[#070a10]/92 px-5 py-6 xl:block">
            <div className="space-y-4">
              <div className="glass-card rounded-3xl p-5">
                <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">当前状态</p>
                <div className="mt-4 space-y-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">当前在哪一步</p>
                    <h3 className="mt-2 text-lg font-semibold text-zinc-50">{sidebarCurrentStep}</h3>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">为什么停在这</p>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">{sidebarReason}</p>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">推荐下一步</p>
                    <p className="mt-2 text-sm font-medium text-zinc-100">{sidebarNextStep}</p>
                  </div>
                </div>
              </div>

              <div className="linear-card rounded-3xl p-5">
                <div className="flex items-center gap-2 text-zinc-300">
                  <ScanSearch className="h-4 w-4 text-cyan-200" />
                  <h4 className="text-sm font-semibold">工坊摘要</h4>
                </div>
                <div className="mt-4 space-y-3 text-sm text-zinc-400">
                  <div className="flex items-center justify-between">
                    <span>作品库存</span>
                    <span className="text-zinc-100">{novels.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>DNA 就绪</span>
                    <span className="text-emerald-200">{readyNovelCount}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>待切分校验</span>
                    <span className="text-rose-200">{novels.filter((novel) => novel.splitStatus === 'needs_review').length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>模型状态</span>
                    <span className={llmReadiness.ok ? 'text-cyan-100' : 'text-amber-200'}>
                      {llmReadiness.ok ? '已就绪' : '待配置'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>变体准入</span>
                    <span className={readyNovelCount > 1 ? 'text-amber-100' : 'text-zinc-400'}>
                      {readyNovelCount > 1 ? '已满足' : `还差 ${Math.max(0, 2 - readyNovelCount)} 部 DNA`}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <SettingsPanel
        isOpen={settingsOpen}
        returnHint={settingsIntent}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsIntent(null);
        }}
      />
    </main>
  );
}
