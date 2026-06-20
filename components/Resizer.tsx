'use client';

import { useEffect, useRef, useState } from 'react';

// 可复用的竖向拖拽分隔条（纯指针交互原语）。AC2 / AC6 / AC7。
// 视觉：1px 发丝线（bg-line）→ hover/拖拽高亮为靛蓝实色（bg-accent，仅实色填充，合视觉铁律）；
// 命中：4px 居中感应区（绝对定位，不占 flex 布局空间）；光标 col-resize。
// 交互：Pointer Events + setPointerCapture（自动跨出界/捕获跟踪，优于 mousedown+全局 mousemove），
//       pointermove 经 requestAnimationFrame 合并为每帧至多一次回调（无掉帧）；双击 → 复位。
// 本组件只「报告」从拖拽起点起的累计像素位移（onResize(deltaPx)），由父组件换算成侧栏 px / 主区 %
// 并经 layoutPrefs 夹取后落地 —— 据此把持久化节流（松手提交）留在父层，组件保持无状态可复用。
interface ResizerProps {
  /** 无障碍标签（如「调整侧栏宽度」）。 */
  ariaLabel: string;
  /** 当前值 / 下限 / 上限，用于 role="separator" 的 aria-valuenow/min/max（AC6）。 */
  ariaValueNow: number;
  ariaValueMin: number;
  ariaValueMax: number;
  /** 拖拽开始（父层在此快照起始值与容器宽）。 */
  onResizeStart: () => void;
  /** 拖拽中（rAF 节流）：deltaPx = 相对拖拽起点的累计水平位移。 */
  onResize: (deltaPx: number) => void;
  /** 拖拽结束（父层在此把最终值提交到持久化 store —— 全程仅此一次写）。 */
  onResizeEnd: () => void;
  /** 双击复位到默认（AC5）。 */
  onReset: () => void;
  /** 附加到根节点的类名（如响应式隐藏 `hidden lg:block`）。 */
  className?: string;
}

export default function Resizer({
  ariaLabel,
  ariaValueNow,
  ariaValueMin,
  ariaValueMax,
  onResizeStart,
  onResize,
  onResizeEnd,
  onReset,
  className,
}: ResizerProps) {
  const [dragging, setDragging] = useState(false); // 仅用于高亮样式
  const draggingRef = useRef(false); // 逻辑闸：同步置位，避免首个 move 事件早于 state 提交而丢帧
  const startXRef = useRef(0);
  const pendingDxRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const lockBody = (locked: boolean) => {
    // 拖拽时全局锁 col-resize + 禁选，避免离开 4px 命中区后光标跳变或选中文本；松手复原。
    document.body.style.cursor = locked ? 'col-resize' : '';
    document.body.style.userSelect = locked ? 'none' : '';
  };

  // 卸载兜底：若组件在拖拽中被卸载（如拖侧栏时 ⌘\ 折叠侧栏使本 Resizer 条件卸载），endDrag 不会触发——
  // 复位全局 body 锁并取消挂起的 rAF，避免 col-resize 光标 / 禁选状态泄漏到全局。
  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // 仅主键
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startXRef.current = e.clientX;
    pendingDxRef.current = 0;
    draggingRef.current = true;
    setDragging(true);
    lockBody(true);
    onResizeStart();
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    pendingDxRef.current = e.clientX - startXRef.current;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        onResize(pendingDxRef.current);
      });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    onResize(pendingDxRef.current); // 末帧补一次，确保提交值反映最后位移
    setDragging(false);
    lockBody(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
    onResizeEnd();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(ariaValueNow)}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      className={`group relative w-px shrink-0 cursor-col-resize touch-none select-none self-stretch transition-colors ${
        dragging ? 'bg-accent' : 'bg-line group-hover:bg-accent'
      } ${className ?? ''}`}
    >
      {/* 4px 居中命中区：绝对定位、不占布局空间；hover 此区即触发 group-hover 高亮上面的 1px 线。 */}
      <span className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2" />
    </div>
  );
}
