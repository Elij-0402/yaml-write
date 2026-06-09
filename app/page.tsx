'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Menu, X } from 'lucide-react';
import { db, type Novel, type FusionSession } from './db';
import { isDnaReady, isExtracting, canAutoStart } from './dnaState';
import { useAppStore, type LLMConfig } from './store';
import { runDnaExtraction } from './dnaEngine';
import { ensureLlmConfigReady } from './llmClient';
import { getLlmReadinessSummary } from './workflow';
import AppRail from '../components/AppRail';
import LibraryView from '../components/LibraryView';
import CreationsView from '../components/CreationsView';
import NovelWorkspace from '../components/NovelWorkspace';
import FusionWorkshop from '../components/FusionWorkshop';
import SettingsPanel from '../components/SettingsPanel';
import AppDialog from '../components/AppDialog';

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
    if (!canAutoStart(novel)) return; // 状态层门：仅全新 idle 自启；已有结果走手动重提，error 不自动重启
    if (chapterCount === 0) return; // 仅「尚无章节（还在解析）」时不跑

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

type Section = 'library' | 'creations';

export default function Home() {
  const {
    selectedNovelId,
    setSelectedNovelId,
    workshopOpen,
    setWorkshopOpen,
    activeCreationId,
    setActiveCreationId,
    llmConfig,
    persistError,
  } = useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsIntent, setSettingsIntent] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [homeSection, setHomeSection] = useState<Section>('library');
  const [dialogState, setDialogState] = useState<
    | { kind: 'deleteNovel'; novel: Novel }
    | { kind: 'deleteCreation'; creation: FusionSession }
    | { kind: 'renameCreation'; creation: FusionSession }
    | null
  >(null);

  // ⌘/Ctrl + , 打开设置
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

  // 组件内 dispatch 的 open-settings-panel 事件（带 intent 提示）
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
  const novels = useMemo(() => novelsRaw || [], [novelsRaw]);
  const selectedNovel = novels.find((novel) => novel.id === selectedNovelId) || null;

  const creationsRaw = useLiveQuery<FusionSession[]>(() => db.fusionSessions.toArray(), []);
  const creationCount = (creationsRaw || []).filter(
    (c) => c.step === 'creator' || c.step === 'manuscript' || Object.keys(c.sceneTexts || {}).length > 0
  ).length;

  const extractingCount = novels.filter((n) => isExtracting(n)).length;
  const llmReadiness = useMemo(() => getLlmReadinessSummary(llmConfig), [llmConfig]);
  const { doneToast, dismissToast } = useBackgroundExtraction(selectedNovelId, llmConfig);

  // 清理幽灵选中：持久化的 selectedNovelId 指向已删除作品时复位（仅在 live 查询解析完成后判断）。
  useEffect(() => {
    if (novelsRaw && selectedNovelId && !novelsRaw.some((n) => n.id === selectedNovelId)) {
      setSelectedNovelId(null);
    }
  }, [novelsRaw, selectedNovelId, setSelectedNovelId]);

  // 进入实体即记住所属段，使「从该实体返回」落回正确的库 home（离开 studio→创作库、离开作品→作品库）。
  useEffect(() => { if (workshopOpen) setHomeSection('creations'); }, [workshopOpen]);
  useEffect(() => { if (selectedNovelId) setHomeSection('library'); }, [selectedNovelId]);

  // 当前视图与导航段由 store flags + homeSection 派生（无需改 store 形状）。
  const view = workshopOpen
    ? 'studio'
    : selectedNovel
    ? 'novel'
    : homeSection === 'creations'
    ? 'creations'
    : 'library';
  const activeSection: Section = workshopOpen ? 'creations' : selectedNovelId ? 'library' : homeSection;

  const selectSection = (section: Section) => {
    setMobileNavOpen(false);
    setSelectedNovelId(null); // 清掉 workshopOpen / activeCreationId / manageMode，回到该段 home
    setHomeSection(section);
  };

  const deleteNovel = async (id: string) => {
    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(id).delete();
      await db.novels.delete(id);
    });
    if (selectedNovelId === id) setSelectedNovelId(null);
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

  const sectionTitle =
    view === 'studio' ? '创作' : view === 'novel' ? selectedNovel?.name || '作品' : view === 'creations' ? '创作库' : '作品库';

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppRail
        activeSection={activeSection}
        onSelectSection={selectSection}
        onOpenSettings={() => { setSettingsOpen(true); setMobileNavOpen(false); }}
        readinessOk={llmReadiness.ok}
        novelCount={novels.length}
        creationCount={creationCount}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 lg:hidden">
          <button onClick={() => setMobileNavOpen(true)} className="btn btn-ghost btn-sm btn-icon" aria-label="打开导航">
            <Menu size={18} />
          </button>
          <span className="truncate text-sm font-medium text-fg">{sectionTitle}</span>
        </div>

        <div
          className={`min-h-0 flex-1 ${view === 'library' || view === 'creations' ? 'overflow-y-auto' : 'overflow-hidden'}`}
        >
          <div className={`p-5 sm:p-6 lg:p-8 ${view === 'novel' || view === 'studio' ? 'h-full' : ''}`}>
            {view === 'studio' ? (
              <FusionWorkshop />
            ) : view === 'novel' && selectedNovel ? (
              <NovelWorkspace novelId={selectedNovel.id} />
            ) : view === 'creations' ? (
              <CreationsView
                onRequestDelete={(creation) => setDialogState({ kind: 'deleteCreation', creation })}
                onRequestRename={(creation) => setDialogState({ kind: 'renameCreation', creation })}
              />
            ) : (
              <LibraryView onRequestDelete={(novel) => setDialogState({ kind: 'deleteNovel', novel })} />
            )}
          </div>
        </div>
      </main>

      <SettingsPanel
        isOpen={settingsOpen}
        returnHint={settingsIntent}
        onClose={() => { setSettingsOpen(false); setSettingsIntent(null); }}
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
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-accent/30 bg-surface px-4 py-2.5 text-sm text-accent shadow-pop"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {doneToast}
          <button onClick={dismissToast} className="text-fg-subtle hover:text-fg" aria-label="关闭通知"><X size={14} /></button>
        </div>
      )}

      {persistError && (
        <div role="alert" className="fixed bottom-6 left-6 z-50 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger-subtle px-3 py-2 text-xs text-danger shadow-pop">
          <span className="h-1.5 w-1.5 rounded-full bg-danger" /> 存储不可用，改动可能未保存
        </div>
      )}

      {extractingCount > 0 && view !== 'novel' && (
        <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted shadow-pop">
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
          {extractingCount} 本作品正在后台提取 DNA
        </div>
      )}
    </div>
  );
}
