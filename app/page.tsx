'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel, type FusionSession } from './db';
import { isDnaReady, isExtracting, canAutoStart } from './dnaState';
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
  if (isDnaReady(novel)) return 'ready';
  if (isExtracting(novel)) return 'extracting';
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
    if (!canAutoStart(novel)) return; // 状态层门：仅全新 idle（无卡、非进行中、非 error）自启；已有结果走手动重提，error 不自动重启
    if (chapterCount === 0) return; // 仅「尚无章节（还在解析）」时不跑；切分质量不再设门——超长 blob 已在导入时预切，整本/弧窗提取不依赖精确分章

    const id = selectedNovelId;
    const name = novel.name;
    runningRef.current = id;
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        await runDnaExtraction(id, { signal: controller.signal });
        const after = await db.novels.get(id);
        if (isDnaReady(after)) setDoneToast(`《${name}》DNA 已就绪`);
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

  const readyCount = novels.filter((novel) => isDnaReady(novel)).length;
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
  const activeCreation = creations.find((creation) => creation.id === activeCreationId) || null;
  const currentWorkspaceLabel = workshopOpen
    ? activeCreation?.name || activeCreation?.directionTitle || '创作工坊'
    : selectedNovel?.name || '总览';
  const activeTaskLabel = workshopBusy
    ? '创作工坊正在处理生成任务，建议保持当前会话。'
    : extractingCount > 0
    ? `有 ${extractingCount} 本作品正在后台提取 DNA。`
    : workflowSummary.recommendedNextStep;
  const readinessTone = llmReadiness.ok ? 'text-[color:var(--add)] border-[color:var(--add)]/25 bg-[color:var(--add-soft)]' : 'text-[color:var(--vermilion)] border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)]';

  return (
    <main className="workspace-shell flex min-h-screen">
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
        } w-[296px] flex-col border-r border-default bg-[color:var(--paper-2)] lg:static lg:z-auto lg:flex`}
      >
        <div className="border-b border-default px-5 py-5">
          <div className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 place-items-center text-[20px] font-bold"
              style={{ background: 'var(--ink)', color: 'var(--paper)', fontFamily: 'var(--font-display)' }}
            >墨</span>
            <div className="leading-tight">
              <div className="text-[16px] text-primary" style={{ fontFamily: 'var(--font-display)', fontWeight: 900 }}>创作 DNA 工坊</div>
              <div className="text-[10px] tracking-[0.22em] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>VARIATION ATELIER</div>
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
                    className={`group relative mb-2 rounded-[12px] border px-4 py-3 transition-all ${
                      active
                        ? 'border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)]'
                        : 'border-default bg-black/10 hover:border-[color:var(--ink)] hover:bg-[color:var(--ink-raise)]'
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
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 hover:text-[color:var(--del)] group-hover:opacity-100"
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
                    className={`group relative mb-2 rounded-[12px] border px-4 py-3 ${
                      active
                        ? 'border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)]'
                        : workshopBusy
                        ? 'cursor-not-allowed border-default bg-black/10 opacity-50'
                        : 'cursor-pointer border-default bg-black/10 hover:bg-[color:var(--ink-raise)]'
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
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 hover:text-[color:var(--del)] group-hover:opacity-100"
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
            className="mt-3 flex w-full items-center justify-between rounded-[12px] border border-default bg-black/10 px-4 py-3 text-left text-sm text-secondary hover:text-primary"
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
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2 text-sm" style={{ fontFamily: 'var(--font-mono)' }}>
            <button
              onClick={() => setMobileNavOpen(true)}
              className="text-secondary hover:text-primary lg:hidden"
              aria-label="打开导航"
            >
              ☰
            </button>
            <span className="truncate text-muted">{currentWorkspaceLabel}</span>
            <span className="text-muted">/</span>
            <span className="truncate text-primary">{currentPath}</span>
              </div>
              <h1 className="mt-2 text-[26px] text-primary sm:text-[30px]" style={{ fontFamily: 'var(--font-display)', fontWeight: 900, lineHeight: 1.06 }}>
                把读过的书，拆成可换皮的引擎与皮。
              </h1>
              {/* 下一步红左栏单行（决策5：外壳留「下一步」一行） */}
              <div className="mt-3 flex max-w-3xl items-center gap-2.5 border-l-[3px] border-[color:var(--vermilion)] py-0.5 pl-3 text-sm">
                <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[color:var(--vermilion)]" style={{ fontFamily: 'var(--font-mono)' }}>下一步</span>
                <span className="text-secondary">{activeTaskLabel}</span>
              </div>
            </div>
            {/* 角落状态 chip */}
            <div className="flex shrink-0 flex-col items-end gap-2">
              <span className={`status-pill ${readinessTone}`}>
                {llmReadiness.ok ? '模型已连接' : '模型待配置'}
              </span>
              {persistError && (
                <span className="status-pill border-[color:var(--warn)] text-[color:var(--warn)]">⚠ 存储不可用</span>
              )}
            </div>
          </div>
        </header>

        {/* 主线进度 Stepper（决策9：工坊态淡化为细带，主视觉让位给工坊） */}
        <div className={`border-b border-default px-4 sm:px-6 lg:px-8 ${workshopOpen ? 'py-2 opacity-55' : 'py-5'}`}>
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
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 border-2 border-[color:var(--add)] bg-[color:var(--paper)] px-4 py-2.5 text-sm text-[color:var(--add)]"
          style={{ boxShadow: '5px 5px 0 var(--ink)' }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--add)]" />
          {doneToast}
          <button onClick={dismissToast} className="text-muted hover:text-primary" aria-label="关闭通知">×</button>
        </div>
      )}
    </main>
  );
}
