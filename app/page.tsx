'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BookMarked,
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
import { getLlmReadinessSummary, getNovelWorkflowSummary } from './workflow';

type LandingMode = 'overview' | 'upload';

const PIPELINE_BLUEPRINT = [
  {
    id: 'import',
    stage: '01 导入文本',
    title: '原文项目创建',
    input: 'TXT 原文与项目名称',
    process: '去广告噪音、规范格式与编码',
    output: '建立本地可控的原稿项目',
    next: '切分校验台',
  },
  {
    id: 'split',
    stage: '02 校验切分',
    title: '章节结构核验',
    input: '已切分的原始章节序列',
    process: '检测超长章、异常极短章与编号断层',
    output: '高连续性、高可信度章节树',
    next: '创作 DNA 提取',
  },
  {
    id: 'dna',
    stage: '03 提取 DNA',
    title: '提炼骨架线索',
    input: '高可信度章节全文',
    process: '逐章映射题材、角色、结构与风格',
    output: '全书收束创作 DNA 卡片',
    next: '碰撞变体工坊',
  },
  {
    id: 'fusion',
    stage: '04 融合变体',
    title: '碰撞变体融合',
    input: '至少两部 DNA 就绪资产',
    process: '方向拟合、故事板生成、SSE 正文流出',
    output: '变体故事板与正文分镜草稿',
    next: '导出与继续迭代',
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

function dnaBadge(novel: Novel): { text: string; dotCls: string } {
  if (novel.analysisStatus === 'done' && novel.dnaCard) {
    return { text: 'DNA 就绪', dotCls: 'bg-emerald-500 shadow-[0_0_6px_#10b981]' };
  }
  if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') {
    const p = novel.mapProgress;
    const pct = p && p.total ? Math.round((p.current / p.total) * 100) : 0;
    return { text: `提取中 ${pct}%`, dotCls: 'bg-amber-500 animate-pulse shadow-[0_0_6px_#f59e0b]' };
  }
  if (novel.splitStatus === 'needs_review') {
    return { text: '切分待校验', dotCls: 'bg-rose-500 shadow-[0_0_6px_#f43f5e]' };
  }
  return { text: '待提取', dotCls: 'bg-zinc-500' };
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
      <div className="glass-card rounded-xl p-8 panel-grid border-hairline bg-zinc-950/60">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-xs text-zinc-400">
            <Sparkles className="h-3 w-3 text-zinc-300" />
            极致克制 · 创作工坊
          </div>
          <h1 className="mt-5 text-3xl font-semibold leading-tight text-zinc-100 tracking-tight">
            从原文长篇提炼创作
            <span className="text-white font-bold"> DNA 骨架与碰撞变体</span>
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
            这里是将长篇小说精炼为核心素材并驱动创新的精密流水线。
            支持自动净化文本、异常章节深度校验、多维度 DNA 映射与多作品创意碰撞。
          </p>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <button
            onClick={onUpload}
            className="glass-card group rounded-xl border border-hairline bg-white/[0.01] p-6 text-left transition-linear hover:border-white/15 hover:bg-white/[0.03] focus-energy"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5 text-zinc-200">
                <FilePlus2 className="h-5 w-5" />
              </div>
              <ChevronRight className="h-4 w-4 text-zinc-600 transition-linear group-hover:text-white" />
            </div>
            <h3 className="mt-4 text-base font-medium text-zinc-200">导入新作品</h3>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              加载本地 TXT 文本，自动识别编码并净化广告字词，直接流转至切分校验台。
            </p>
          </button>

          <button
            onClick={onContinue}
            disabled={!latestNovel}
            className="glass-card group rounded-xl border border-hairline bg-white/[0.01] p-6 text-left transition-linear hover:border-white/15 hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5 text-zinc-200">
                <Compass className="h-5 w-5" />
              </div>
              <ChevronRight className="h-4 w-4 text-zinc-600 transition-linear group-hover:text-white" />
            </div>
            <h3 className="mt-4 text-base font-medium text-zinc-200">继续最近作品</h3>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              {latestNovel
                ? `回到《${latestNovel.name}》的当前任务节点，继续向前推进。`
                : '首批作品导入后，此通道将记录并显示您的最近作业进度。'}
            </p>
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
        {PIPELINE_BLUEPRINT.map((item) => (
          <div key={item.id} className="linear-card rounded-xl p-5 bg-zinc-950/20 border-hairline">
            <p className="text-[10px] font-mono tracking-widest text-zinc-600 uppercase">{item.stage}</p>
            <h3 className="mt-3 text-sm font-medium text-zinc-200">{item.title}</h3>
            <div className="mt-4 space-y-2 text-xs text-zinc-500 leading-relaxed">
              <p><span className="text-zinc-400">输入：</span>{item.input}</p>
              <p><span className="text-zinc-400">处理：</span>{item.process}</p>
              <p><span className="text-zinc-400">产出：</span>{item.output}</p>
              <p><span className="text-zinc-300 font-mono">NEXT：</span>{item.next}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="linear-card rounded-xl p-5 bg-zinc-950/20 border-hairline">
          <p className="text-[10px] font-mono tracking-widest text-zinc-600 uppercase">作品库存</p>
          <p className="mt-3 text-2xl font-mono font-medium text-zinc-300">{novels.length}</p>
          <p className="mt-2 text-xs text-zinc-500">工坊内已被导入的完整项目总数。</p>
        </div>
        <div className="linear-card rounded-xl p-5 bg-zinc-950/20 border-hairline">
          <p className="text-[10px] font-mono tracking-widest text-zinc-600 uppercase">DNA 就绪</p>
          <p className="mt-3 text-2xl font-mono font-medium text-zinc-300">{readyNovelCount}</p>
          <p className="mt-2 text-xs text-zinc-500">可直接用作创意碰撞输入的成熟作品。</p>
        </div>
        <div className="linear-card rounded-xl p-5 bg-zinc-950/20 border-hairline">
          <p className="text-[10px] font-mono tracking-widest text-zinc-600 uppercase">待校验异常</p>
          <p className="mt-3 text-2xl font-mono font-medium text-zinc-300">{needsReviewCount}</p>
          <p className="mt-2 text-xs text-zinc-500">分章规则存在存疑点、需人工介入校验的项目。</p>
        </div>
        <div className="linear-card rounded-xl p-5 bg-zinc-950/20 border-hairline">
          <p className="text-[10px] font-mono tracking-widest text-zinc-600 uppercase">大模型引擎</p>
          <div className="mt-3 flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${llmReady ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <p className="text-base font-medium text-zinc-300">{llmReady ? '就绪' : '待启动'}</p>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {llmReady ? 'LLM 已点亮，随时可发起章节映射提取与创意碰撞。' : '请先在底部启动面板配置大模型接口密钥。'}
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
  const [helpOpen, setHelpOpen] = useState(true);
  const [settingsIntent, setSettingsIntent] = useState<string | null>(null);
  const [landingMode, setLandingMode] = useState<LandingMode>('overview');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setHelpOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
    if (typeof window !== 'undefined' && !window.confirm('确认删除该小说及其所有章节数据？该动作无法撤销。')) return;
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
      ? '多部作品的创作 DNA 均已点亮，准入条件满足，当前正位于变体融合工坊。'
      : '库内缺乏足够（至少 2 本）的 DNA 资产，融合变体被阻断，请先提炼单部作品。'
    : selectedSummary.readinessReason ||
      workflowStages.find((stage) => stage.status === 'blocked' || stage.status === 'ready')?.hint ||
      '当前链路无阻碍，可顺利往下一阶段流动。';
  const sidebarNextStep = workshopOpen
    ? readyNovelCount > 1
      ? '启动创意碰撞与设定微调'
      : '去点亮其他原稿的 DNA 提取'
    : selectedSummary.recommendedNextStep;
  const sidebarCurrentStep = workshopOpen
    ? '融合变体阶段'
    : selectedNovel
    ? headerLabel
    : '导入文本阶段';

  return (
    <main className="flex min-h-screen bg-[var(--bg-app)] text-zinc-100">
      <aside className="linear-border-r hidden w-[270px] shrink-0 flex-col bg-[#050505] lg:flex">
        <div className="linear-border-b px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2 text-zinc-200">
              <Orbit className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-sm font-medium tracking-tight text-zinc-100">创作 DNA 工坊</h1>
              <p className="mt-0.5 text-[9px] font-mono tracking-widest text-zinc-600 uppercase">CREATIVE DNA LAB</p>
            </div>
          </div>

          <button
            onClick={() => {
              setSelectedNovelId(null);
              setWorkshopOpen(false);
              setManageMode(false);
              setLandingMode('upload');
            }}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs font-medium text-zinc-200 transition-linear hover:border-white/20 hover:bg-white/[0.04]"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            导入新原稿
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3.5 py-4">
          <div className="mb-3 px-1.5 flex items-center justify-between">
            <span className="text-[10px] font-mono tracking-wider text-zinc-600 uppercase">小说项目列表</span>
            <span className="font-mono text-[10px] text-zinc-500">{novels.length}</span>
          </div>

          <div className="space-y-2">
            {novels.length === 0 && (
              <div className="rounded-xl border border-dashed border-hairline bg-white/[0.01] p-4 text-xs leading-relaxed text-zinc-600">
                暂无作品。请先从上方导入本地 TXT 原文。
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
                  className={`group relative w-full rounded-xl border p-3.5 text-left transition-linear ${
                    active
                      ? 'border-zinc-700 bg-zinc-900/40'
                      : 'border-hairline bg-white/[0.015] hover:border-white/10 hover:bg-white/[0.03]'
                  }`}
                >
                  {active && <span className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r bg-white" />}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-zinc-200">{novel.name}</p>
                      <p className="mt-1 text-[10px] text-zinc-600 font-mono">
                        {formatWordCount(novel.wordCount)} · {formatTime(novel.createdAt)}
                      </p>
                    </div>
                    <button
                      onClick={(event) => void deleteNovel(novel.id, event)}
                      className="rounded-full border border-hairline p-1 text-zinc-600 opacity-0 group-hover:opacity-100 transition-linear hover:border-white/15 hover:text-rose-400"
                      title="删除原稿"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.02] pt-2">
                    <span className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                      <span className={`h-1.5 w-1.5 rounded-full ${badge.dotCls}`} />
                      {badge.text}
                    </span>
                    <span className="text-[10px] text-zinc-500 truncate max-w-[100px]">{workflow.recommendedNextStep}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="linear-border-t space-y-2 px-3.5 py-4 bg-[#030303]">
          <button
            onClick={() => setWorkshopOpen(true)}
            className={`flex w-full items-center gap-3 rounded-xl border px-4 py-2.5 text-xs font-medium transition-linear ${
              workshopOpen
                ? 'border-zinc-700 bg-zinc-900/40 text-white'
                : 'border-hairline bg-white/[0.015] text-zinc-300 hover:border-white/10 hover:bg-white/[0.03]'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            变体融合工坊
          </button>
          <button
            onClick={() => {
              setSettingsIntent(workshopOpen ? '融合变体' : selectedNovel ? 'DNA 提取' : '创作工坊');
              setSettingsOpen(true);
            }}
            className="flex w-full items-center gap-3 rounded-xl border border-hairline bg-white/[0.015] px-4 py-2.5 text-xs font-medium text-zinc-300 transition-linear hover:border-white/10 hover:bg-white/[0.03]"
          >
            <Settings className="h-3.5 w-3.5" />
            启动面板
            <span className="ml-auto text-[10px] text-zinc-500 font-mono">
              {llmReadiness.ok ? 'ON' : 'OFF'}
            </span>
          </button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[#000000]">
        <header className="linear-border-b sticky top-0 z-20 bg-[#000000]/70 backdrop-blur-xl">
          <div className="px-5 py-4 lg:px-8">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                    <BookMarked className="h-3 w-3" />
                    <span className="truncate max-w-[120px]">{selectedNovel ? selectedNovel.name : workshopOpen ? '变体工坊' : '总览'}</span>
                    <span>/</span>
                    <span>{workshopOpen ? '变体融合' : selectedNovel ? '原稿处理' : '流程总览'}</span>
                    <span>/</span>
                    <span className="text-zinc-400">{headerLabel}</span>
                  </div>
                  <h2 className="mt-1.5 text-base font-semibold text-zinc-100 tracking-tight">{headerLabel}</h2>
                </div>

                <div className="flex items-center gap-2 rounded-full border border-hairline bg-white/[0.01] px-3 py-1.5 text-xs text-zinc-400">
                  <span className={`h-1.5 w-1.5 rounded-full ${llmReadiness.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                  <span className="font-mono text-[10px]">ENGINE: {llmReadiness.ok ? 'READY' : 'OFFLINE'}</span>
                </div>
              </div>

              {/* Monochromatic Horizontal Timeline Stepper */}
              <div className="linear-border-t pt-3 flex items-center justify-between w-full overflow-x-auto gap-4 scrollbar-none">
                {workflowStages.map((stage, index) => {
                  const isActive = stage.status === 'running' || stage.status === 'ready';
                  const isDone = stage.status === 'done';
                  const isBlocked = stage.status === 'blocked';
                  
                  let labelColor = 'text-zinc-600';
                  if (isActive) {
                    labelColor = 'text-white font-medium';
                  } else if (isDone) {
                    labelColor = 'text-zinc-300';
                  } else if (isBlocked) {
                    labelColor = 'text-zinc-500';
                  }

                  return (
                    <div key={stage.id} className="flex flex-1 items-center gap-3 min-w-max">
                      <div className={`flex items-center gap-2 ${labelColor} text-[11px]`}>
                        <span className={`flex h-4.5 w-4.5 items-center justify-center rounded-full border text-[9px] font-mono ${
                          isActive 
                            ? 'bg-white text-black border-white shadow-[0_0_8px_rgba(255,255,255,0.4)]' 
                            : isDone
                            ? 'bg-zinc-800 border-zinc-700 text-zinc-400'
                            : 'bg-transparent border-zinc-900 text-zinc-600'
                        }`}>
                          0{index + 1}
                        </span>
                        <span className="tracking-tight">{stage.label}</span>
                        {isActive && (
                          <span className="hidden xl:inline text-[9px] text-zinc-400 opacity-80 font-normal">
                            ({stage.hint.split('，')[0].split('。')[0]})
                          </span>
                        )}
                      </div>
                      {index < workflowStages.length - 1 && (
                        <div className="flex-1 h-[1px] min-w-[20px] bg-zinc-900 mx-1" />
                      )}
                    </div>
                  );
                })}
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

          {helpOpen && (
            <aside className="linear-border-l hidden w-[300px] shrink-0 overflow-y-auto bg-surface-1 px-5 py-6 xl:block">
              <div className="space-y-4">
                <div className="glass-card rounded-xl p-5 border-hairline bg-zinc-950/40">
                <p className="text-[10px] font-mono tracking-wider text-zinc-600 uppercase">当前任务</p>
                <div className="mt-4 space-y-4">
                  <div>
                    <p className="text-[10px] text-zinc-500 font-mono">当前在哪一步</p>
                    <h3 className="mt-1 text-sm font-semibold text-zinc-200">{sidebarCurrentStep}</h3>
                  </div>
                  <div>
                    <p className="text-[10px] text-zinc-500 font-mono">任务轨迹背景</p>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-400">{sidebarReason}</p>
                  </div>
                  <div className="rounded-xl border border-hairline bg-white/[0.01] px-4 py-3">
                    <p className="text-[10px] text-zinc-400 font-mono">推荐下一步动作</p>
                    <p className="mt-1 text-xs font-medium text-zinc-200">{sidebarNextStep}</p>
                  </div>
                </div>
              </div>

              <div className="linear-card rounded-xl p-5 border-hairline bg-zinc-950/20">
                <div className="flex items-center gap-2 text-zinc-400">
                  <ScanSearch className="h-3.5 w-3.5 text-zinc-300" />
                  <h4 className="text-xs font-semibold">工坊摘要数据</h4>
                </div>
                <div className="mt-4 space-y-2.5 text-xs text-zinc-500">
                  <div className="flex items-center justify-between">
                    <span>原稿项目库存</span>
                    <span className="font-mono text-zinc-300">{novels.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>DNA 就绪数</span>
                    <span className="font-mono text-zinc-300">{readyNovelCount}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>切分待核验</span>
                    <span className="font-mono text-zinc-300">{novels.filter((n) => n.splitStatus === 'needs_review').length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>引擎就绪状态</span>
                    <span className="font-mono text-zinc-300">{llmReadiness.ok ? 'OK' : 'OFFLINE'}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-white/[0.02] pt-2">
                    <span>变体碰撞准入</span>
                    <span className="font-mono text-zinc-300">
                      {readyNovelCount > 1 ? '满足' : `缺 ${Math.max(0, 2 - readyNovelCount)} 部`}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}
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
