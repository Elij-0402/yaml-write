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
import { getLlmReadinessSummary, getNovelWorkflowSummary, type WorkflowStage } from './workflow';

function getStatus(novel: Novel): string {
  if (novel.analysisStatus === 'done' && novel.dnaCard) return 'ready';
  if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') return 'extracting';
  if (novel.splitStatus === 'needs_review') return 'review';
  return 'pending';
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
        <div className="flex h-12 items-center gap-2.5 border-b px-4">
          <span
            className="grid h-7 w-7 place-items-center rounded-md text-[15px] font-bold text-white"
            style={{ background: 'var(--vermilion)', fontFamily: 'var(--font-serif)', boxShadow: '0 2px 10px rgba(207,74,46,.35)' }}
          >墨</span>
          <div className="leading-tight">
            <div className="text-[14px] text-primary" style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>创作DNA工坊</div>
            <div className="text-[9px] tracking-[1.5px] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>VARIATION ATELIER</div>
          </div>
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
