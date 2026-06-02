'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel, type FusionSession } from './db';
import { useAppStore } from './store';
import NovelUploader from '../components/NovelUploader';
import NovelDetail from '../components/NovelDetail';
import FusionWorkshop from '../components/FusionWorkshop';
import SettingsPanel from '../components/SettingsPanel';
import WorkflowStepper from '../components/WorkflowStepper';
import { getLlmReadinessSummary, getNovelWorkflowSummary, type WorkflowStage } from './workflow';

function getStatus(novel: Novel): string {
  if (novel.analysisStatus === 'done' && novel.dnaCard) return 'ready';
  if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') return 'extracting';
  if (novel.splitStatus === 'needs_review') return 'review';
  return 'pending';
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
    (c) => c.step === 'creator' || Object.keys(c.sceneTexts || {}).length > 0
  );

  const readyCount = novels.filter((novel) => novel.analysisStatus === 'done' && novel.dnaCard).length;
  const llmReadiness = useMemo(() => getLlmReadinessSummary(llmConfig), [llmConfig]);
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
    if (!window.confirm('删除此作品？')) return;
    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(id).delete();
      await db.novels.delete(id);
    });
    if (selectedNovelId === id) {
      setSelectedNovelId(null);
    }
  };

  const deleteCreation = async (id: string) => {
    if (!window.confirm('删除此创作？')) return;
    await db.fusionSessions.delete(id);
    if (activeCreationId === id) {
      setWorkshopOpen(false);
      setActiveCreationId(null);
    }
  };

  const renameCreation = (creation: FusionSession) => {
    const next = window.prompt('重命名创作', creation.name || creation.directionTitle || '');
    if (next && next.trim()) {
      void db.fusionSessions.update(creation.id, { name: next.trim(), updatedAt: Date.now() });
    }
  };

  return (
    <main className="flex min-h-screen">
      {/* Mobile nav scrim */}
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
        />
      )}

      {/* Sidebar — static on lg, slide-in drawer below lg */}
      <aside
        className={`${
          mobileNavOpen ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden'
        } w-56 flex-col border-r bg-black lg:static lg:z-auto lg:flex`}
      >
        <div className="flex h-12 items-center border-b px-4">
          <span className="text-sm text-secondary">创作 DNA 工坊</span>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <button onClick={goImport} className="w-full px-4 py-2 text-left text-sm text-secondary hover:text-primary">
            + 导入作品
          </button>

          {novels.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <div className="px-4 pb-2 text-xs text-muted">作品 ({novels.length})</div>
              {novels.map((novel) => {
                const active = !workshopOpen && selectedNovelId === novel.id;
                const status = getStatus(novel);
                return (
                  <div
                    key={novel.id}
                    className={`group relative cursor-pointer px-4 py-2 ${active ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
                  >
                    <div
                      onClick={() => {
                        setSelectedNovelId(novel.id);
                        setWorkshopOpen(false);
                        setMobileNavOpen(false);
                      }}
                      className="flex items-center justify-between"
                    >
                      <span className={`truncate text-sm ${active ? 'text-primary' : 'text-secondary'}`}>
                        {novel.name}
                      </span>
                      <span className="ml-2 text-xs text-muted">
                        {status === 'ready' ? '●' : status === 'extracting' ? '◐' : status === 'review' ? '○' : '·'}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteNovel(novel.id);
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
            <div className="mt-4 border-t pt-4">
              <div className="px-4 pb-2 text-xs text-muted">创作 ({creations.length})</div>
              {creations.map((creation) => {
                const active = workshopOpen && activeCreationId === creation.id;
                return (
                  <div
                    key={creation.id}
                    title={workshopBusy && !active ? '生成中，暂不可切换创作' : undefined}
                    className={`group relative px-4 py-2 ${
                      active
                        ? 'bg-secondary'
                        : workshopBusy
                        ? 'cursor-not-allowed opacity-50'
                        : 'cursor-pointer hover:bg-secondary/50'
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
                        renameCreation(creation);
                      }}
                      className="absolute right-7 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 hover:text-primary group-hover:opacity-100"
                    >
                      ✎
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteCreation(creation.id);
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

        <div className="border-t py-2">
          <button
            onClick={() => {
              if (workshopBusy || readyCount < 1) return;
              setActiveCreationId(crypto.randomUUID());
              setMobileNavOpen(false);
            }}
            className={`w-full px-4 py-2 text-left text-sm ${
              workshopBusy || readyCount < 1
                ? 'cursor-not-allowed text-muted'
                : workshopOpen
                ? 'text-primary'
                : 'text-secondary hover:text-primary'
            }`}
          >
            + 新建创作 {readyCount >= 1 && <span className="text-muted">({readyCount})</span>}
          </button>
          <button
            onClick={() => {
              setSettingsOpen(true);
              setMobileNavOpen(false);
            }}
            className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-secondary hover:text-primary"
          >
            <span>设置</span>
            <span className={`text-xs ${llmReadiness.ok ? 'text-emerald-500' : 'text-amber-500'}`}>
              {llmReadiness.ok ? '●' : '○'}
            </span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between gap-3 border-b px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="text-secondary hover:text-primary lg:hidden"
              aria-label="打开导航"
            >
              ☰
            </button>
            <span className="truncate text-muted">{selectedNovel?.name || '工坊'}</span>
            <span className="text-muted">/</span>
            <span className="truncate">{currentPath}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {persistError && (
              <span
                className="text-xs text-amber-500"
                title="浏览器本地存储不可用（隐私模式或空间不足），设置与密钥可能无法保存。"
              >
                ⚠ 存储不可用
              </span>
            )}
            <span className={`text-xs ${llmReadiness.ok ? 'text-secondary' : 'text-amber-500'}`}>
              {llmReadiness.ok ? 'LLM Ready' : 'LLM Offline'}
            </span>
          </div>
        </header>

        {/* 主线进度 Stepper */}
        <div className="border-b px-4 py-2 sm:px-6">
          <WorkflowStepper summary={workflowSummary} currentStageId={currentStageId} onStageClick={handleStageClick} />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
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
    </main>
  );
}
