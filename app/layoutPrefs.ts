// 三栏伸缩布局偏好的「纯规划」层：默认值 + 边界夹取 + 脏数据归一化。
// 不碰任何 DOM / localStorage / Zustand —— 组件与 store 拿这些纯函数算出合法值再落地，
// 与 chapterOps.ts / dnaRouting.ts 同为「纯规划层」范式，便于把约束算术单测（夹取 / 容器换算 / 容错）。
//
// 约束来源（AC1 / AC5 / UX EXPERIENCE.md）：
// · 侧栏宽 160–400px（折叠态为 0，是独立开关，不受下限约束 —— 由 sidebarCollapsed 单独表达）。
// · 右侧 AI pane 占屏宽 25%–60%，且实际像素不低于 300px（二者取更严者）。
// · mainSplitPct = 左 pane（编辑器）占比；右 pane 占比 = 100 - mainSplitPct。

export interface LayoutPrefs {
  /** 侧栏展开时的宽度（px），夹在 160–400。 */
  sidebarWidth: number;
  /** 侧栏是否折叠（折叠时视觉宽为 0，与 sidebarWidth 解耦，便于展开后恢复原宽）。 */
  sidebarCollapsed: boolean;
  /** 左 pane（编辑器占位）占主工作区的百分比；右 pane = 100 - 此值。 */
  mainSplitPct: number;
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  sidebarWidth: 240,
  sidebarCollapsed: false,
  mainSplitPct: 55,
};

// 侧栏宽下/上限（折叠态 0 由 sidebarCollapsed 表达，不在此夹取）。
const SIDEBAR_MIN_PX = 160;
const SIDEBAR_MAX_PX = 400;

// 右 pane 占比下/上限（百分比），与最小像素地板。
const RIGHT_PCT_MIN = 25;
const RIGHT_PCT_MAX = 60;
const RIGHT_MIN_PX = 300;

/** 侧栏宽夹在 [160, 400] 并取整 px；非有限值回落默认宽度（脏持久化兜底）。 */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_LAYOUT.sidebarWidth;
  return Math.round(Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, px)));
}

/**
 * 把左 pane 占比夹进合法区间。约束实际定义在「右 pane」上，故先换算成右 pane 占比再夹取：
 * · 上限：右 ≤ 60%。
 * · 下限：右 ≥ 25%，且当传入 containerPx 时右 ≥ 300px（取更严 / 更大的下限）。
 * 顺序上「先封顶再托底」，使极窄容器下 300px 硬地板能压过 60% 上限（取更严者）。
 * 不传 containerPx 时只应用与容器无关的静态边界（右 25–60% ⇒ 左 40–75），供注水/迁移期使用。
 */
export function clampMainSplitPct(pct: number, containerPx?: number): number {
  const leftPct = Number.isFinite(pct) ? pct : DEFAULT_LAYOUT.mainSplitPct;
  let rightPct = 100 - leftPct;

  rightPct = Math.min(rightPct, RIGHT_PCT_MAX); // 封顶：右 ≤ 60%
  const rightMin =
    containerPx && containerPx > 0
      ? Math.max(RIGHT_PCT_MIN, (RIGHT_MIN_PX / containerPx) * 100) // 取更严者
      : RIGHT_PCT_MIN;
  rightPct = Math.max(rightPct, rightMin); // 托底：右 ≥ 下限（地板最后应用 → 极窄容器下压过封顶）

  return 100 - rightPct;
}

/**
 * 归一化任意来源的布局值为合法 LayoutPrefs（迁移旧用户 / 容错脏值 / 补齐缺失字段）。
 * 这里只应用与容器无关的静态夹取；右 pane 的 300px 像素地板在渲染/拖拽期由 clampMainSplitPct(pct, containerPx) 再保。
 * 始终返回新对象（绝不泄露 DEFAULT_LAYOUT 引用，避免调用方意外突变共享默认值）。
 */
export function normalizeLayout(raw: unknown): LayoutPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LAYOUT };
  const r = raw as Record<string, unknown>;

  const sidebarWidth = clampSidebarWidth(
    typeof r.sidebarWidth === 'number' ? r.sidebarWidth : DEFAULT_LAYOUT.sidebarWidth,
  );
  const sidebarCollapsed =
    typeof r.sidebarCollapsed === 'boolean' ? r.sidebarCollapsed : DEFAULT_LAYOUT.sidebarCollapsed;
  const mainSplitPct = clampMainSplitPct(
    typeof r.mainSplitPct === 'number' ? r.mainSplitPct : DEFAULT_LAYOUT.mainSplitPct,
  );

  return { sidebarWidth, sidebarCollapsed, mainSplitPct };
}
