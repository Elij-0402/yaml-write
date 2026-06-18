/**
 * 冷启动状态判断逻辑。
 * 从 page.tsx 中抽离，便于独立测试。
 */

export interface ColdStartState {
  /** 显示骨架屏（IndexedDB 确认为空） */
  showSkeleton: boolean;
  /** 显示正常占位文本（有数据） */
  showEmptyPlaceholder: boolean;
  /** IndexedDB 查询尚未返回，UI 应保持空白避免闪烁 */
  isLoading: boolean;
}

/**
 * 根据 IndexedDB 中的小说数量判断冷启动 UI 状态。
 *
 * 三态设计：
 * - `undefined`（useLiveQuery 首次返回前）→ 加载中，不渲染骨架屏也不渲染占位，避免闪烁
 * - `0`   → 显示骨架屏
 * - `> 0` → 显示正常占位文本
 *
 * 负数按 0 处理（防御性，useLiveQuery 不会返回负数）。
 */
export function getColdStartState(novelCount: number | undefined): ColdStartState {
  if (novelCount === undefined) {
    return { showSkeleton: false, showEmptyPlaceholder: false, isLoading: true };
  }
  const safeCount = Math.max(0, novelCount);
  if (safeCount === 0) {
    return { showSkeleton: true, showEmptyPlaceholder: false, isLoading: false };
  }
  return { showSkeleton: false, showEmptyPlaceholder: true, isLoading: false };
}