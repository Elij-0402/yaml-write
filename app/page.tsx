'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel, type FusionSession } from './db';
import { useAppStore, type LLMConfig } from './store';
import { runDnaExtraction } from './dnaEngine';
import { ensureLlmConfigReady } from './llmClient';
import NovelUploader from '../components/NovelUploader';
import NovelDetail from '../components/NovelDetail';
import FusionWorkshop from '../components/FusionWorkshop';
import SettingsPanel from '../components/SettingsPanel';
import WorkflowStepper from '../components/WorkflowStepper';
import AppDialog from '../components/AppDialog';
import { getLlmReadinessSummary, getNovelWorkflowSummary, type WorkflowStage } from './workflow';

function getStatus(novel: Novel): string {
  if (novel.analysisStatus === 'done' && novel.dnaCard) return 'ready';
  if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') return 'extracting';
  if (novel.splitStatus === 'needs_review') return 'review';
  return 'pending';
}

function getStatusLabel(status: string): string {
  if (status === 'ready') return 'DNA 就绪';
  if (status === 'extracting') return '提取中';
  if (status === 'review') return '待校验';
  return '待处理';
}

// 后台自适应提取（NFR1）：导入/选中一部 idle 且无 DNA 的作品时，自动在后台起提取——
// 用户可离开（page.tsx 常驻，run 不随面板切换中止），跑完弹「DNA 就绪」通知。单飞 + 完成后再评估（队列推进）。
// 仅作用于「当前选中」作品，避免应用启动时对历史未提取作品批量开跑。提取本身可续跑、挂载自愈（见 dnaEngine/NovelDetail）。
function useBackgroundExtraction(selectedNovelId: string | null, llmConfig: LLMConfig) {
  const novel = useLiveQuery(
    () => (selectedNovelId ? db.novels.get(selectedNovelId) : undefined),
    [selectedNovelId],
  );
  const chapterCount = useLiveQuery(
    () => (selectedNovelId ? db.chapters.where('novelId').equals(selectedNovelId).count() : 0),
    [selectedNovelId],
  ) ?? 0;
  const runningRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [doneToast, setDoneToast] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (runningRef.current) return; // 单飞：一次只跑一部
    if (!selectedNovelId || !novel) return;
    if (!ensureLlmConfigReady(llmConfig).ok) return; // 未配密钥不自动跑（配好后本 effect 因 llmConfig 变化重评）
    if (novel.analysisStatus !== 'idle' || novel.dnaCard) return; // 已就绪/进行中/出错都不自动起
    if (chapterCount === 0 || novel.splitStatus !== 'ok') return; // 未切分/切分异常先不自动跑（出问题才提示）

    const id = selectedNovelId;
    const name = novel.name;
    runningRef.current = id;
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        await runDnaExtraction(id, { signal: controller.signal });
        const after = await db.novels.get(id);
        if (after?.analysisStatus === 'done') setDoneToast(`《${name}》DNA 已就绪`);
      } catch {
        /* 失败落到 analysisStatus='error'，书详情展示原因与重试入口 */
      } finally {
        runningRef.current = null;
        abortRef.current = null;
        setTick((t) => t + 1); // 完成后再评估当前选中是否仍需提取
      }
    })();
  }, [novel, selectedNovelId, chapterCount, llmConfig, tick]);

  // 卸载（应用关闭）时中止在飞提取；进度已逐章持久化，下次可续跑。
  useEffect(() => () => abortRef.current?.abort(), []);

  // 通知 ~5s 自动消隐。
  useEffect(() => {
    if (!doneToast) return;
    const t = setTimeout(() => setDoneToast(null), 5000);
    return () => clearTimeout(t);
  }, [doneToast]);

  return { doneToast, dismissToast: () => setDoneToast(null) };
}

export default function Home() {
  const {
    selectedNovelId,
    setSelectedNovelId,
    workshopOpen,
    setWorkshopOpen,
    activeCreationId,
    setActiveCreationId,
    workshopBusy,
    manageMode,
    setManageMode,
    llmConfig,
    persistError,
  } = useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsIntent, setSettingsIntent] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dialogState, setDialogState] = useState<
    | { kind: 'deleteNovel'; novel: Novel }
    | { kind: 'deleteCreation'; creation: FusionSession }
    | { kind: 'renameCreation'; creation: FusionSession }
    | null
  >(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{ intent?: string }>;
      setSettingsIntent(custom.detail?.intent || null);
      setSettingsOpen(true);
    };
    window.addEventListener('open-settings-panel', handler as EventListener);
    return () => window.removeEventListener('open-settings-panel', handler as EventListener);
  }, []);

  const novelsRaw = useLiveQuery<Novel[]>(() => db.novels.orderBy('createdAt').reverse().toArray(), []);
  const novels = novelsRaw || [];
  const selectedNovel = novels.find((novel) => novel.id === selectedNovelId) || null;

  // 创作库：仅展示已进入创作台或已有正文的创作（过滤掉未成形的空白/方向期会话）。
  const creationsRaw = useLiveQuery<FusionSession[]>(
    () => db.fusionSessions.orderBy('createdAt').reverse().toArray(),
    []
  );
  const creations = (creationsRaw || []).filter(
    (c) => c.step === 'creator' || c.step === 'manuscript' || Object.keys(c.sceneTexts || {}).length > 0
  );

  const readyCount = novels.filter((novel) => novel.analysisStatus === 'done' && novel.dnaCard).length;
  const llmReadiness = useMemo(() => getLlmReadinessSummary(llmConfig), [llmConfig]);
  const { doneToast, dismissToast } = useBackgroundExtraction(selectedNovelId, llmConfig);
  const workflowSummary = useMemo(
    () => getNovelWorkflowSummary(selectedNovel, llmConfig, readyCount),
    [selectedNovel, llmConfig, readyCount]
  );

  // 清理幽灵选中：持久化的 selectedNovelId 指向已删除作品时复位（仅在 live 查询解析完成后判断，避免误清加载中的有效选择）。
  useEffect(() => {
    if (novelsRaw && selectedNovelId && !novelsRaw.some((n) => n.id === selectedNovelId)) {
      setSelectedNovelId(null);
    }
  }, [novelsRaw, selectedNovelId, setSelectedNovelId]);

  const currentStageId: WorkflowStage['id'] = workshopOpen
    ? 'fusion'
    : selectedNovel
    ? manageMode
      ? 'split'
      : 'dna'
    : 'import';

  const currentPath = workshopOpen
    ? '融合工坊'
    : selectedNovel
    ? manageMode
      ? '章节校验'
      : '作品详情'
    : '总览';

  const goImport = () => {
    setSelectedNovelId(null);
    setWorkshopOpen(false);
    setManageMode(false);
    setMobileNavOpen(false);
  };

  // 阶段门导航：语义层由 stepper 驱动，用户不再直面三标志拼凑。
  const handleStageClick = (id: WorkflowStage['id']) => {
    setMobileNavOpen(false);
    switch (id) {
      case 'import':
        setSelectedNovelId(null);
        break;
      case 'split':
        if (selectedNovel) {
          setWorkshopOpen(false);
          setManageMode(true);
        }
        break;
      case 'dna':
        if (selectedNovel) setSelectedNovelId(selectedNovel.id);
        else if (!llmReadiness.ok) setSettingsOpen(true);
        break;
      case 'fusion':
        if (readyCount >= 1) setActiveCreationId(crypto.randomUUID());
        break;
    }
  };

  const deleteNovel = async (id: string) => {
    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(id).delete();
      await db.novels.delete(id);
    });
    if (selectedNovelId === id) {
      setSelectedNovelId(null);
    }
  };

  const deleteCreation = async (id: string) => {
    await db.fusionSessions.delete(id);
    if (activeCreationId === id) {
      setWorkshopOpen(false);
      setActiveCreationId(null);
    }
  };

  const renameCreation = (creation: FusionSession, nextName?: string) => {
    if (nextName && nextName.trim()) {
      void db.fusionSessions.update(creation.id, { name: nextName.trim(), updatedAt: Date.now() });
    }
  };

  const extractingCount = novels.filter((novel) => getStatus(novel) === 'extracting').length;
  const reviewCount = novels.filter((novel) => getStatus(novel) === 'review').length;
  const activeCreation = creations.find((creation) => creation.id === activeCreationId) || null;
  const currentWorkspaceLabel = workshopOpen
    ? activeCreation?.name || activeCreation?.directionTitle || '创作工坊'
    : selectedNovel?.name || '总览';
  const shellStats = [
    { label: '作品库', value: novels.length, hint: readyCount > 0 ? `${readyCount} 本 DNA 就绪` : '等待首本完成 DNA' },
    { label: '待校验', value: reviewCount, hint: reviewCount > 0 ? '优先修正章节边界' : '切分结构稳定' },
    { label: '创作台', value: creations.length, hint: workshopBusy ? '当前有生成任务' : '随时回到未完稿件' },
  ];
  const activeTaskLabel = workshopBusy
    ? '创作工坊正在处理生成任务，建议保持当前会话。'
    : extractingCount > 0
    ? `有 ${extractingCount} 本作品正在后台提取 DNA。`
    : workflowSummary.recommendedNextStep;
  const readinessTone = llmReadiness.ok ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/[0.06]' : 'text-amber-400 border-amber-500/20 bg-amber-500/[0.06]';

  return (
    <main className="workspace-shell flex min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(207,74,46,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(137,147,161,0.08),transparent_22%)]">
      {/* Mobile nav scrim */}
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/70 backdrop-blur-sm lg:hidden"
        />
      )}

      {/* Sidebar — static on lg, slide-in drawer below lg */}
      <aside
        className={`${
          mobileNavOpen ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden'
        } w-[296px] flex-col border-r border-default bg-[linear-gradient(180deg,rgba(14,11,10,0.98),rgba(22,18,15,0.98))] lg:static lg:z-auto lg:flex`}
      >
        <div className="border-b border-default px-5 py-5">
          <div className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 place-items-center rounded-2xl text-[18px] font-bold text-white"
              style={{ background: 'linear-gradient(180deg,var(--vermilion),#9f351d)', fontFamily: 'var(--font-serif)', boxShadow: '0 12px 28px rgba(207,74,46,.32)' }}
            >墨</span>
            <div className="leading-tight">
              <div className="text-[16px] text-primary" style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>创作 DNA 工坊</div>
              <div className="text-[10px] tracking-[0.22em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>PRO WRITING WORKBENCH</div>
            </div>
          </div>
          <div className="mt-4 rounded-[20px] border border-default bg-[rgba(239,230,214,0.03)] p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>Workspace Pulse</div>
            <div className="mt-2 text-sm leading-6 text-primary">所有作品、DNA 和创作会话都挂在同一条连续工作流上。</div>
            <div className="mt-3 text-xs leading-6 text-secondary">{activeTaskLabel}</div>
            <div className="mt-4 grid gap-2">
              {shellStats.map((item) => (
                <div key={item.label} className="flex items-center justify-between rounded-2xl border border-default bg-black/10 px-3 py-2.5">
                  <div>
                    <div className="text-[11px] text-muted">{item.label}</div>
                    <div className="text-[11px] text-secondary">{item.hint}</div>
                  </div>
                  <div className="text-xl text-primary" style={{ fontFamily: 'var(--font-display)' }}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <button onClick={goImport} className="workspace-button w-full justify-between">
            <span>导入新作品</span>
            <span className="font-mono text-xs">+</span>
          </button>

          {novels.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 px-1 text-[11px] uppercase tracking-[0.18em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>作品库 · {novels.length}</div>
              {novels.map((novel) => {
                const active = !workshopOpen && selectedNovelId === novel.id;
                const status = getStatus(novel);
                return (
                  <div
                    key={novel.id}
                    className={`group relative mb-2 rounded-[18px] border px-4 py-3 transition-all ${
                      active
                        ? 'border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)] shadow-[0_10px_28px_rgba(0,0,0,0.14)]'
                        : 'border-default bg-black/10 hover:border-[color:var(--line-strong)] hover:bg-[rgba(26,21,18,0.72)]'
                    }`}
                  >
                    <div
                      onClick={() => {
                        setSelectedNovelId(novel.id);
                        setWorkshopOpen(false);
                        setMobileNavOpen(false);
                      }}
                      className="flex items-center justify-between"
                    >
                      <div className="min-w-0">
                        <span className={`block truncate text-sm ${active ? 'text-primary' : 'text-secondary'}`}>
                          {novel.name}
                        </span>
                        <span className="mt-1 inline-flex rounded-full border border-default px-2 py-0.5 text-[10px] text-muted">{getStatusLabel(status)}</span>
                      </div>
                      <span className="ml-3 text-xs text-muted">
                        {status === 'ready' ? '●' : status === 'extracting' ? '◐' : status === 'review' ? '○' : '·'}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialogState({ kind: 'deleteNovel', novel });
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 hover:text-red-400 group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {creations.length > 0 && (
            <div className="mt-5 border-t border-default pt-5">
              <div className="mb-2 px-1 text-[11px] uppercase tracking-[0.18em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>创作会话 · {creations.length}</div>
              {creations.map((creation) => {
                const active = workshopOpen && activeCreationId === creation.id;
                return (
                  <div
                    key={creation.id}
                    title={workshopBusy && !active ? '生成中，暂不可切换创作' : undefined}
                    className={`group relative mb-2 rounded-[18px] border px-4 py-3 ${
                      active
                        ? 'border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)]'
                        : workshopBusy
                        ? 'cursor-not-allowed border-default bg-black/10 opacity-50'
                        : 'cursor-pointer border-default bg-black/10 hover:bg-[rgba(26,21,18,0.72)]'
                    }`}
                  >
                    <div
                      onClick={() => {
                        if (workshopBusy) return;
                        setActiveCreationId(creation.id);
                        setMobileNavOpen(false);
                      }}
                      className="flex items-center justify-between"
                    >
                      <span className={`truncate text-sm ${active ? 'text-primary' : 'text-secondary'}`}>
                        {creation.name || creation.directionTitle || '未命名创作'}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialogState({ kind: 'renameCreation', creation });
                      }}
                      className="absolute right-7 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 hover:text-primary group-hover:opacity-100"
                    >
                      ✎
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialogState({ kind: 'deleteCreation', creation });
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 hover:text-red-400 group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-default px-4 py-4">
          <button
            onClick={() => {
              if (workshopBusy || readyCount < 1) return;
              setActiveCreationId(crypto.randomUUID());
              setMobileNavOpen(false);
            }}
            className={`workspace-button w-full justify-between ${workshopBusy || readyCount < 1 ? 'opacity-50' : ''}`}
            disabled={workshopBusy || readyCount < 1}
          >
            <span>新建创作</span>
            <span className="font-mono text-xs">{readyCount >= 1 ? readyCount : '0'}</span>
          </button>
          <button
            onClick={() => {
              setSettingsOpen(true);
              setMobileNavOpen(false);
            }}
            className="mt-3 flex w-full items-center justify-between rounded-[18px] border border-default bg-black/10 px-4 py-3 text-left text-sm text-secondary hover:text-primary"
          >
            <div>
              <span className="block text-primary">模型与偏好设置</span>
              <span className="text-[11px] text-muted">管理 API Key、模型地址和当前工作流阻塞项</span>
            </div>
            <span className={`status-pill ${readinessTone}`}>
              {llmReadiness.ok ? '已连接' : '待配置'}
            </span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <section className="relative z-[1] flex min-w-0 flex-1 flex-col">
        <header className="border-b border-default px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2 text-sm">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="text-secondary hover:text-primary lg:hidden"
              aria-label="打开导航"
            >
              ☰
            </button>
            <span className="truncate text-muted">{currentWorkspaceLabel}</span>
            <span className="text-muted">/</span>
            <span className="truncate">{currentPath}</span>
              </div>
              <h1 className="mt-2 text-[30px] text-primary sm:text-[34px]" style={{ fontFamily: 'var(--font-display)', lineHeight: 1.08 }}>
                专业创作台，围绕一条主线完成导入、抽取与生成。
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-secondary">
                现在的界面重点不是“看起来像 AI 工具”，而是让高频创作动作和后台状态都稳定、清楚、可追溯。
              </p>
            </div>
            <div className="grid min-w-[280px] gap-3 sm:grid-cols-2">
              <div className="panel-soft p-4">
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>Current Guidance</div>
                <div className="mt-2 text-sm text-primary">{workflowSummary.recommendedNextStep}</div>
                <div className="mt-1 text-xs leading-6 text-secondary">{currentWorkspaceLabel} 的下一步已经锁定，不需要再自己猜流程。</div>
              </div>
              <div className="panel-soft p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>System Readiness</div>
                  <span className={`status-pill ${readinessTone}`}>
                    {llmReadiness.ok ? '模型已连接' : '模型待配置'}
                  </span>
                </div>
                <div className="mt-2 text-xs leading-6 text-secondary">
                  {persistError
                    ? '浏览器本地存储暂不可用，设置与密钥可能无法稳定保存。'
                    : llmReadiness.ok
                    ? '模型链路正常，适合继续做 DNA 提取和创作生成。'
                    : llmReadiness.reason || '配置模型后，阻塞中的阶段会自动恢复。'}
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* 主线进度 Stepper */}
        <div className="border-b border-default px-4 py-5 sm:px-6 lg:px-8">
          <WorkflowStepper summary={workflowSummary} currentStageId={currentStageId} onStageClick={handleStageClick} />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          {workshopOpen ? (
            <FusionWorkshop />
          ) : selectedNovel && !manageMode ? (
            <NovelDetail novelId={selectedNovel.id} />
          ) : (
            <NovelUploader />
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

      <AppDialog
        open={dialogState?.kind === 'deleteNovel'}
        title="删除这本作品？"
        description={dialogState?.kind === 'deleteNovel' ? `《${dialogState.novel.name}》的章节、DNA 进度和相关上下文都会被移除。` : ''}
        confirmLabel="确认删除"
        confirmTone="danger"
        onClose={() => setDialogState(null)}
        onConfirm={() => {
          if (dialogState?.kind === 'deleteNovel') void deleteNovel(dialogState.novel.id);
          setDialogState(null);
        }}
      />

      <AppDialog
        open={dialogState?.kind === 'deleteCreation'}
        title="删除这条创作记录？"
        description={dialogState?.kind === 'deleteCreation' ? `《${dialogState.creation.name || dialogState.creation.directionTitle || '未命名创作'}》的设定、正文和历史会话都会被移除。` : ''}
        confirmLabel="确认删除"
        confirmTone="danger"
        onClose={() => setDialogState(null)}
        onConfirm={() => {
          if (dialogState?.kind === 'deleteCreation') void deleteCreation(dialogState.creation.id);
          setDialogState(null);
        }}
      />

      <AppDialog
        open={dialogState?.kind === 'renameCreation'}
        title="重命名创作"
        description="给这条创作记录一个更容易识别的名字，方便你在创作库里继续接着写。"
        confirmLabel="保存名称"
        inputLabel="创作名称"
        initialValue={dialogState?.kind === 'renameCreation' ? dialogState.creation.name || dialogState.creation.directionTitle || '' : ''}
        placeholder="例如：废土婚约开篇"
        onClose={() => setDialogState(null)}
        onConfirm={(value) => {
          if (dialogState?.kind === 'renameCreation') renameCreation(dialogState.creation, value);
          setDialogState(null);
        }}
      />

      {/* 后台提取完成通知（NFR1：发起→通知） */}
      {doneToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-emerald-500/30 bg-black/90 px-4 py-2.5 text-sm text-emerald-400 shadow-2xl"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {doneToast}
          <button onClick={dismissToast} className="text-muted hover:text-primary" aria-label="关闭通知">×</button>
        </div>
      )}
    </main>
  );
}
