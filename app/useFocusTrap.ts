import { useEffect, type RefObject } from 'react';

// 模态焦点陷阱：active 时把焦点移入容器（优先表单控件，否则首个可聚焦元素），
// Tab / Shift+Tab 在容器内循环不逃逸，关闭时把焦点归还给打开前的触发元素。
// 不处理 Esc —— 各模态保留自有的 Esc 关闭逻辑；尊重 prefers-reduced-motion（仅移焦，无动画）。
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container || typeof document === 'undefined') return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const SELECTOR =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(SELECTOR)).filter(
        (el) => el.getAttribute('tabindex') !== '-1',
      );

    // 初始聚焦：优先首个文本控件（表单模态如重命名/凭证），否则首个可聚焦元素。
    const items = focusable();
    const firstField = items.find((el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    (firstField ?? items[0])?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusable();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !container.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (activeEl === last || !container.contains(activeEl))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef]);
}
