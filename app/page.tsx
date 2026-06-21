'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Menu, X, WifiOff, ListTree, Layers } from 'lucide-react';
import { db, type Novel, type FusionSession } from './db';
import { isDnaReady, isExtracting, canAutoStart } from './dnaState';
import { useAppStore, type LLMConfig } from './store';
import { clampSidebarWidth, clampMainSplitPct, DEFAULT_LAYOUT } from './layoutPrefs';
import { runDnaExtraction } from './dnaEngine';
import { ensureLlmConfigReady } from './llmClient';
import AppRail from '../components/AppRail';
import CommandPalette from '../components/CommandPalette';
import LibraryView from '../components/LibraryView';
import CreationsView from '../components/CreationsView';
import NovelWorkspace from '../components/NovelWorkspace';
import FusionWorkshop from '../components/FusionWorkshop';
import SettingsPanel from '../components/SettingsPanel';
import AppDialog from '../components/AppDialog';
import Resizer from '../components/Resizer';
import SkeletonTree from '../components/SkeletonTree';
import OutlineTree from '../components/OutlineTree';
import EntityCardLibrary from '../components/EntityCardLibrary';
import ApiKeyNoticeCard from '../components/ApiKeyNoticeCard';
import { getColdStartState } from './coldStartState';
import { getInitialOnline, canUseLlm, OFFLINE_TOAST_TEXT, OFFLINE_DISABLED_HINT } from './networkStatus';
import StatusBar from '../components/StatusBar';
import AppNotice from '../components/AppNotice';

// 后台自适应提取（NFR1）：导入/选中一部 idle 且无 DNA 的作品时，自动在后台起提取——
// 用户可离开（page.tsx 常驻，run 不随面板切换中止），跑完弹「DNA 就绪」通知。单飞 + 完成后再评估（队列推进）。
// 仅作用于「当前选中」作品，避免应用启动时对历史未提取作品批量开跑。提取本身可续跑、挂载自愈（见 dnaEngine/NovelDetail）。
// 自动化分流（goal·流程自动化）：仅「高置信切分」自动起跑；中置信不自动跑（DNA 板给「直接开始提取」一键入口）；
// 低置信（needs_review）由 canAutoStart 之外再加 splitStatus/confidenceLevel 闸守住——导入即落人工校验台。
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
    // 切分置信度闸（goal）：只有高置信才自动测序。中/低置信交给用户在 DNA 板「直接开始提取」或先去校验，
    // 避免把质量存疑的切分静默喂进 DNA 提取。splitStatus 已对 low 标 needs_review，这里进一步要求 high。
    if (novel.splitStatus !== 'ok' || novel.splitMeta?.confidenceLevel !== 'high') return;
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
    isOffline,
    setOffline,
    layout,
    setSidebarWidth,
    toggleSidebar,
    setMainSplitPct,
    resetSidebar,
  } = useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsIntent, setSettingsIntent] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [homeSection, setHomeSection] = useState<Section>('library');
  // 侧栏「大纲 ⇄ 设定卡」面板切换（Story 2.2）：临时 UI 态，仿 homeSection —— 不进 store、不持久化。
  const [sidebarPanel, setSidebarPanel] = useState<'outline' | 'cards'>('outline');
  // 离线 Toast 开关（AC5）：UI 就绪、触发接线顺延 Epic 3。Epic 1 无可点击 AI 控件，故暂不会被置 true；
  // state 与 setter 均被引用（关闭按钮即用 setter）→ 非死代码。
  const [offlineToastOpen, setOfflineToastOpen] = useState(false);
  const [dialogState, setDialogState] = useState<
    | { kind: 'deleteNovel'; novel: Novel }
    | { kind: 'deleteCreation'; creation: FusionSession }
    | { kind: 'renameCreation'; creation: FusionSession }
    | null
  >(null);

  // ⌘/Ctrl + , 设置 · ⌘/Ctrl + K 命令面板（打开面板时收起设置与移动端抽屉）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((prev) => {
          const next = !prev;
          if (next) { setSettingsOpen(false); setMobileNavOpen(false); }
          return next;
        });
      } else if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        // 折叠/展开侧栏（AC6）。并入既有 handler，勿另起监听；用 getState 取最新 action 避免闭包陈旧。
        e.preventDefault();
        useAppStore.getState().toggleSidebar();
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

  // 网络离线监听（AC1）：挂载即按 navigator.onLine 求一次真（断网中刷新也正确显示离线，不依赖事件补发），
  // 并监听 online/offline 事件写入全局 isOffline；卸载移除（复刻既有 add/removeEventListener 范式）。
  useEffect(() => {
    setOffline(!getInitialOnline());
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [setOffline]);

  const novelsRaw = useLiveQuery<Novel[]>(() => db.novels.orderBy('createdAt').reverse().toArray(), []);
  const novels = useMemo(() => novelsRaw || [], [novelsRaw]);
  const selectedNovel = novels.find((novel) => novel.id === selectedNovelId) || null;

  const creationsRaw = useLiveQuery<FusionSession[]>(() => db.fusionSessions.toArray(), []);
  const creationCount = (creationsRaw || []).filter(
    (c) => c.step === 'creator' || c.step === 'manuscript' || Object.keys(c.sceneTexts || {}).length > 0
  ).length;
  const activeCreation = useLiveQuery(
    () => (activeCreationId ? db.fusionSessions.get(activeCreationId) : undefined),
    [activeCreationId],
  );

  const extractingCount = novels.filter((n) => isExtracting(n)).length;
  const llmReadiness = useMemo(() => ensureLlmConfigReady(llmConfig), [llmConfig]);
  const coldStart = useMemo(() => getColdStartState(novelsRaw?.length), [novelsRaw?.length]);
  const { doneToast, dismissToast } = useBackgroundExtraction(selectedNovelId, llmConfig);

  // 清理幽灵选中：持久化的 selectedNovelId 指向已删除作品时复位。
  // liveQuery 数组可能短暂滞后于刚提交的写入（导入后立即选中的场景），
  // 因此不能只看 novelsRaw —— 复位前再查一次 DB，确认真的不存在才清。
  useEffect(() => {
    if (!novelsRaw || !selectedNovelId) return;
    if (novelsRaw.some((n) => n.id === selectedNovelId)) return;
    let cancelled = false;
    void db.novels.get(selectedNovelId).then((hit) => {
      if (!cancelled && !hit) setSelectedNovelId(null);
    });
    return () => { cancelled = true; };
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

  // 顶栏面包屑：根段可点（回库），当前实体为纯文本。
  const breadcrumb: { label: string; onClick?: () => void }[] =
    view === 'studio'
      ? [
          { label: '创作库', onClick: () => selectSection('creations') },
          { label: activeCreation?.name || activeCreation?.directionTitle || '新创作' },
        ]
      : view === 'novel'
      ? [
          { label: '作品库', onClick: () => selectSection('library') },
          { label: selectedNovel?.name || '作品' },
        ]
      : [{ label: view === 'creations' ? '创作库' : '作品库' }];

  // —— 布局注水门控（T2 / AC3）：persist 挂载后才注水。注水前用默认渲染、注水后再启用宽度过渡，
  //    避免冷启时宽度从默认「跳变」到持久值造成 layout shift。 ——
  const [layoutHydrated, setLayoutHydrated] = useState(false);
  useEffect(() => {
    if (useAppStore.persist.hasHydrated()) setLayoutHydrated(true);
    return useAppStore.persist.onFinishHydration(() => setLayoutHydrated(true));
  }, []);

  // 过渡就绪：注水后「下一帧」再开启宽度过渡，使「默认→持久值」的首次切换瞬时完成（不产生动画），
  // 之后用户的折叠 / 拖拽 / 复位才平滑过渡（AC3「无缝恢复、无 layout shift」）。
  const [transReady, setTransReady] = useState(false);
  useEffect(() => {
    if (!layoutHydrated) return;
    const id = requestAnimationFrame(() => setTransReady(true));
    return () => cancelAnimationFrame(id);
  }, [layoutHydrated]);

  // —— 拖拽瞬时布局值（null = 未拖拽 → 用持久化 store 值）。AC7：拖拽期只动本地态（rAF 平滑、零 localStorage 写），
  //    松手时一次性提交 store（→ 经 safeLocalStorage 持久化一次，写失败仍走 persistError 路径），不每帧写盘。 ——
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const [dragSidebarWidth, setDragSidebarWidth] = useState<number | null>(null);
  const [dragSplitPct, setDragSplitPct] = useState<number | null>(null);
  const sidebarStartRef = useRef(0); // 侧栏拖拽起始宽（px）
  const splitStartRef = useRef(0); // 主区拖拽起始占比（%）
  const splitContainerRef = useRef(0); // 主区容器宽（px），用于 px→% 换算与右 pane ≥300px 夹取
  const sidebarCommitRef = useRef(0); // 待提交的侧栏宽（末值）
  const splitCommitRef = useRef(0); // 待提交的占比（末值）

  // 水合门控的「生效布局」：注水前（SSR / 首帧）一律用默认值，使服务端与客户端首帧一致，
  // 避免宽度 / 折叠态水合不一致；注水后切到持久值。拖拽瞬时值（仅注水后发生）照常覆盖。
  const effLayout = layoutHydrated ? layout : DEFAULT_LAYOUT;
  const sidebarWidth = dragSidebarWidth ?? effLayout.sidebarWidth;
  const mainSplitPct = dragSplitPct ?? effLayout.mainSplitPct;
  const draggingSidebar = dragSidebarWidth !== null;
  const draggingSplit = dragSplitPct !== null;

  // 侧栏 Resizer：拖拽改 sidebarWidth（px，直接加 delta）。
  const onSidebarResizeStart = () => { sidebarStartRef.current = layout.sidebarWidth; };
  const onSidebarResize = (dx: number) => {
    const next = clampSidebarWidth(sidebarStartRef.current + dx);
    sidebarCommitRef.current = next;
    setDragSidebarWidth(next);
  };
  const onSidebarResizeEnd = () => { setSidebarWidth(sidebarCommitRef.current); setDragSidebarWidth(null); };

  // 主区 Resizer：拖拽改 mainSplitPct（%）。delta(px) 按容器宽换算成 %，夹取含「右 pane ≥300px / 25–60%」。
  const onSplitResizeStart = () => {
    splitStartRef.current = layout.mainSplitPct;
    splitContainerRef.current = mainAreaRef.current?.clientWidth ?? 0;
  };
  const onSplitResize = (dx: number) => {
    const w = splitContainerRef.current;
    const next = w > 0 ? clampMainSplitPct(splitStartRef.current + (dx / w) * 100, w) : splitStartRef.current;
    splitCommitRef.current = next;
    setDragSplitPct(next);
  };
  const onSplitResizeEnd = () => { setMainSplitPct(splitCommitRef.current, splitContainerRef.current); setDragSplitPct(null); };

  // 双击复位主区分隔条（AC5）：按当前容器宽走容器感知夹取，使复位值与拖拽 / 注水路径一致地守住
  // 「右 pane ≥300px」地板（窄视口 + 宽侧栏时默认 55% 会让右 pane <300px，故不能直接写默认值）。
  const onSplitReset = () => {
    const w = mainAreaRef.current?.clientWidth ?? 0;
    setMainSplitPct(DEFAULT_LAYOUT.mainSplitPct, w > 0 ? w : undefined);
  };

  // P0（评审决策 D1）：注水完成后按主区容器宽对持久化占比补一次「右 pane ≥300px」地板夹取。
  // normalizeLayout 只做与容器无关的静态夹取（右 ≥25%，无 px 地板），故在较窄视口加载持久化的高左占比时，
  // 右 pane 初次渲染可能 <300px。这里 mount 后补一次（按评审决策仅做最小修复，不加 resize 监听）。
  useEffect(() => {
    if (!layoutHydrated) return;
    const w = mainAreaRef.current?.clientWidth ?? 0;
    if (w <= 0) return;
    const { layout: l, setMainSplitPct: commit } = useAppStore.getState();
    if (clampMainSplitPct(l.mainSplitPct, w) !== l.mainSplitPct) commit(l.mainSplitPct, w);
  }, [layoutHydrated]);

  // 评审 #2：注水完成后移除首帧防闪类（app/layout.tsx 的 LAYOUT_BOOTSTRAP 加的 .va-sidebar-collapsed），
  // 交还 React inline 宽度控制（否则展开时 globals.css 的 !important 会把侧栏钉死在 0）。必须在 layoutHydrated
  // 翻转后的渲染（此时折叠态已由 effLayout 落成 inline width:0）之后执行 → 单列 effect 依赖 [layoutHydrated]，
  // 避免在 React 接管前移除类导致回弹到默认展开闪一下。
  useEffect(() => {
    if (layoutHydrated) document.documentElement.classList.remove('va-sidebar-collapsed');
  }, [layoutHydrated]);

  // 评审 #1 残留：折叠时清掉瞬时拖拽宽。覆盖「拖侧栏 Resizer 时按 ⌘\\ 折叠 → Resizer 条件卸载 →
  // onSidebarResizeEnd 未触发 → dragSidebarWidth 滞留非 null」的边角，避免再展开时侧栏停在陈旧拖拽值且过渡被抑制。
  // 正常折叠时 dragSidebarWidth 已为 null（setState 同值，React 跳过 → 幂等无害）。
  useEffect(() => {
    if (effLayout.sidebarCollapsed) setDragSidebarWidth(null);
  }, [effLayout.sidebarCollapsed]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      {/* 横向工作区行（AppRail + 侧栏 + Resizer + 主区）；下方接 28px 全宽底部状态栏（AC2）。
          根容器改 flex-col 以容纳底栏；本行 min-h-0 flex-1 保证主区仍可内部滚动、不被底栏挤出。 */}
      <div className="flex min-h-0 flex-1">
      <AppRail
        activeSection={activeSection}
        onSelectSection={selectSection}
        onOpenSettings={() => { setSettingsOpen(true); setMobileNavOpen(false); }}
        onOpenPalette={() => { setPaletteOpen(true); setMobileNavOpen(false); }}
        readinessOk={llmReadiness.ok}
        novelCount={novels.length}
        creationCount={creationCount}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        sidebarCollapsed={effLayout.sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
      />

      {/* 可折叠侧栏（三级大纲树 · Story 2.1 接入）—— 桌面专属；移动端导航走 AppRail 抽屉。 */}
      <aside
        data-app-sidebar
        style={{ width: effLayout.sidebarCollapsed ? 0 : sidebarWidth }}
        aria-hidden={effLayout.sidebarCollapsed}
        className={`hidden shrink-0 flex-col overflow-hidden bg-panel lg:flex ${
          transReady && !draggingSidebar ? 'transition-[width] duration-150 motion-reduce:transition-none' : ''
        }`}
      >
        <div className="flex h-12 shrink-0 items-center border-b border-line px-3">
          {selectedNovelId ? (
            <div className="seg" role="tablist" aria-label="侧栏面板">
              <button
                role="tab"
                aria-selected={sidebarPanel === 'outline'}
                onClick={() => setSidebarPanel('outline')}
                className="seg-item"
              >
                <ListTree size={13} /> 大纲
              </button>
              <button
                role="tab"
                aria-selected={sidebarPanel === 'cards'}
                onClick={() => setSidebarPanel('cards')}
                className="seg-item"
              >
                <Layers size={13} /> 设定卡
              </button>
            </div>
          ) : (
            <span className="eyebrow">大纲</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {coldStart.showSkeleton ? (
            <SkeletonTree />
          ) : coldStart.isLoading ? null : selectedNovelId ? (
            sidebarPanel === 'cards' ? (
              <EntityCardLibrary novelId={selectedNovelId} />
            ) : (
              <OutlineTree novelId={selectedNovelId} />
            )
          ) : (
            <p className="px-2 py-2 text-[12.5px] leading-relaxed text-fg-subtle">
              从作品库选择一部作品，即可在此编排它的三级大纲。
            </p>
          )}
        </div>
      </aside>

      {/* 侧栏 ↔ 主区分隔条（折叠时不渲染） */}
      {!effLayout.sidebarCollapsed && (
        <Resizer
          className="hidden lg:block va-sidebar-resizer"
          ariaLabel="调整侧栏宽度"
          ariaValueNow={sidebarWidth}
          ariaValueMin={160}
          ariaValueMax={400}
          onResizeStart={onSidebarResizeStart}
          onResize={onSidebarResize}
          onResizeEnd={onSidebarResizeEnd}
          onReset={resetSidebar}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：面包屑 + 全局后台活动。 */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 lg:px-5">
          <button onClick={() => setMobileNavOpen(true)} className="btn btn-ghost btn-sm btn-icon lg:hidden" aria-label="打开导航">
            <Menu size={16} />
          </button>

          <nav aria-label="当前位置" className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
            {breadcrumb.map((seg, i) => (
              <React.Fragment key={`${seg.label}-${i}`}>
                {i > 0 && <span className="text-fg-subtle">/</span>}
                {seg.onClick ? (
                  <button onClick={seg.onClick} className="shrink-0 text-fg-muted transition-colors hover:text-fg">{seg.label}</button>
                ) : (
                  <span className="truncate font-medium text-fg">{seg.label}</span>
                )}
              </React.Fragment>
            ))}
          </nav>

          {extractingCount > 0 && (
            <span className="flex shrink-0 items-center gap-2 rounded-sm border border-line bg-surface px-2 py-1 text-[11px] text-fg-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
              提取中 <span className="font-mono tabular-nums">{extractingCount}</span>
            </span>
          )}
        </header>

        {/* 双栏主工作区：左 pane（编辑器 / 现有视图画布）+ Resizer + 右 pane（AI 助手占位）。 */}
        <div ref={mainAreaRef} className="flex min-h-0 flex-1">
          {/* 左 pane：承载现有视图（库 / 创作 / 作品 / 工坊）；真实正文编辑器待 Epic 4。
              移动端 flex-1 占满（右 pane 隐藏）；桌面 lg:flex-none 用 inline 宽度 %。 */}
          <section
            style={{ width: `${mainSplitPct}%` }}
            className={`flex min-w-0 flex-1 flex-col lg:flex-none ${
              transReady && !draggingSplit ? 'lg:transition-[width] lg:duration-150 motion-reduce:transition-none' : ''
            }`}
          >
            <div className={`min-h-0 flex-1 ${view === 'library' || view === 'creations' ? 'overflow-y-auto' : 'overflow-hidden'}`}>
              <div className={`p-5 sm:p-6 lg:p-7 ${view === 'novel' || view === 'studio' ? 'h-full' : ''}`}>
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
          </section>

          {/* 左 ↔ 右 分隔条（桌面专属） */}
          <Resizer
            className="hidden lg:block"
            ariaLabel="调整编辑器与 AI 助手的占比"
            ariaValueNow={mainSplitPct}
            ariaValueMin={40}
            ariaValueMax={75}
            onResizeStart={onSplitResizeStart}
            onResize={onSplitResize}
            onResizeEnd={onSplitResizeEnd}
            onReset={onSplitReset}
          />

          {/* 右 pane：AI 助手占位（Epic 3 接入）—— 桌面专属。 */}
          <aside
            style={{ width: `${100 - mainSplitPct}%` }}
            className={`hidden min-w-0 flex-col bg-panel lg:flex lg:flex-none ${
              transReady && !draggingSplit ? 'lg:transition-[width] lg:duration-150 motion-reduce:transition-none' : ''
            }`}
          >
            <div className="flex h-12 shrink-0 items-center border-b border-line px-4">
              <span className="eyebrow">AI 助手</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {/* 拦截闸门（AC3）：canUseLlm = 密钥就绪且在线。离线优先于缺密钥提示（网络是更底层阻断，二者不堆叠）。 */}
              {isOffline ? (
                <AppNotice tone="warning" title="离线模式" className="mb-4">
                  {OFFLINE_DISABLED_HINT}。本地写作与大纲编辑不受影响，已安全保存；恢复网络后自动可用。
                </AppNotice>
              ) : !llmReadiness.ok ? (
                <ApiKeyNoticeCard
                  onConfigure={() => window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'api-key' } }))}
                />
              ) : null}
              <div className={canUseLlm(llmReadiness.ok, isOffline) ? '' : 'opacity-50 pointer-events-none'}>
                <p className="text-[12.5px] leading-relaxed text-fg-subtle">
                  AI 对话与闭环起草将在后续故事（Epic 3）接入。此处为双栏右侧的占位容器。
                </p>
              </div>
            </div>
          </aside>
        </div>
      </main>
      </div>

      {/* 全宽 28px 底部状态栏（AC2）：承载在线 / 离线模式连通指示，跨工作区底边。 */}
      <StatusBar isOffline={isOffline} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectSection={selectSection}
        onOpenSettings={() => { setSettingsOpen(true); setSettingsIntent(null); }}
      />

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
          className="pop-enter fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-lg border border-line bg-surface px-4 py-2.5 text-[13px] text-fg shadow-pop"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
          {doneToast}
          <button onClick={dismissToast} className="ml-1 text-fg-subtle transition-colors hover:text-fg" aria-label="关闭通知"><X size={14} /></button>
        </div>
      )}

      {persistError && (
        <div role="alert" className="fixed bottom-10 left-6 z-50 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger-subtle px-3 py-2 text-xs text-danger shadow-pop">
          <span className="h-1.5 w-1.5 rounded-full bg-danger" /> 存储不可用，改动可能未保存
        </div>
      )}

      {/* 离线 Toast（AC5）：UI 就绪、触发接线顺延 Epic 3——届时发送/起草按钮 disabled={!canUseLlm(llmReadiness.ok, isOffline)}，
          被拦截时调用 setOfflineToastOpen(true) 弹此提示。复刻 doneToast 的 role=status/aria-live/.pop-enter/fixed bottom-6 范式，
          红点 + WifiOff + OFFLINE_TOAST_TEXT，零 Emoji。Epic 1 无可点击 AI 控件，此 toast 暂不会被触发（非死代码）。 */}
      {offlineToastOpen && (
        <div
          role="status"
          aria-live="polite"
          className="pop-enter fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-lg border border-line bg-surface px-4 py-2.5 text-[13px] text-fg shadow-pop"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
          <WifiOff size={14} className="shrink-0 text-danger" />
          {OFFLINE_TOAST_TEXT}
          <button onClick={() => setOfflineToastOpen(false)} className="ml-1 text-fg-subtle transition-colors hover:text-fg" aria-label="关闭通知"><X size={14} /></button>
        </div>
      )}
    </div>
  );
}
