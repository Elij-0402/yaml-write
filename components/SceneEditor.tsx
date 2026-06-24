'use client';

// 成稿开篇的可编辑正文区（Story 4.1 · FR-EDIT；Story 4.2 追加划词改写 UI）。核心诉求：当侧栏大纲 / 设定卡
// 在后台刷新（useLiveQuery 重绘）时，绝不打断作者的打字光标与选区。实现路径（见 4.1 Dev Notes「焦点隔离」）：
//   ① 非受控 <textarea>（defaultValue + ref）——编辑期间 DOM 自管 value/光标，父级重渲染不会重置它。
//      这才是焦点隔离的「根」：只要不触碰 el.value，无论组件重渲染多少次都不动光标。
//   ② React.memo（默认浅比较）——纯性能护栏：父级因 activeCards / 大纲 liveQuery 高频重绘时，本组件
//      props 值不变即跳过重渲染。要求父级把 onCommit/onSelect 等以 useCallback 稳定化方能跳过；但即便
//      偶发重渲染也不伤光标（见 ①），故 memo 非正确性来源，不必再用「忽略函数引用」的自定义比较去硬扛。
//   ③ 仅当「外部权威值」变化（切场景 / 流式 / 接受改写 / 恢复历史版 / 切创作）时才把值同步进 DOM；用一次性
//      echoRef 把「本组件自身防抖写回经父级 state 折返回来的回声」与「外部新值」区分开——回声跳过（值已在
//      DOM，回灌只会跳光标），外部新值则先作废未触发的防抖写回再写 DOM。
//   ④ 输入经 createDebouncer(1s) 静默写回，不每键落盘 / 不每键触发上层重绘（见 app/editorOps.ts）。
//
// 关键不变量：防抖缓冲只属于「正在打字的作者」。一旦编辑器被生成接管（disabled）或外部权威值取代缓冲，
// 必须立即作废未触发的写回（cancel）——否则陈旧缓冲会在 1s 后回灌，污染流式正文，或把上一处创作的文本
// 串写进刚切过去的另一处创作。
//
// 注：<textarea> 的选区在 selectionStart/End，window.getSelection() 取不到——故选句改写（onSelect）
// 直接读 textarea 自身选区传出，而非沿用旧只读视图的 window.getSelection 路径。
//
// Story 4.2：onSelect 由「传子串」加宽为「传结构化选区 {text,start,end,rects,anchor}」（start/end 供接受时
// 做**索引区间替换**，杜绝同句首次匹配误伤）；选区**高亮叠层** + **浮动触角**在本组件的定位 wrapper 内绘制
// （textarea 无法对子串上色 → 用 pointer-events:none 叠层盒按镜像量算的选区矩形绘制，失焦后仍可见）。
// 镜像量算（DOM 副作用）是薄壳，纯几何/区间算术下沉到 app/selectionRect.ts（已单测）。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createDebouncer, resolveExternalSync, type Debouncer } from '../app/editorOps';
import { selectionRectToContainer, type ProseSelection, type SelectionRect } from '../app/selectionRect';
import FloatingRewriteTrigger from './FloatingRewriteTrigger';

interface SceneEditorProps {
  /** 场景标识；变化即视为切换场景，强制按「外部新值」重载文本（本故事恒为开篇 OPENING_SCENE_NUM）。 */
  sceneId: number | string;
  /** 外部权威文本（= sceneTexts[OPENING_SCENE_NUM]）；流式 / 改写 / 恢复历史版会改变它。 */
  initialText: string;
  /** 流式生成中禁编（仍展示流式增长的文本）。 */
  disabled?: boolean;
  /** 防抖写回：停止输入 debounceMs 后用最新文本调用。应为稳定引用（父级 useCallback）。 */
  onCommit: (text: string) => void;
  /** 选区回调：传出结构化选区（含字符索引与容器相对矩形）；空选区传 null。应为稳定引用（父级 useCallback）。 */
  onSelect?: (selection: ProseSelection | null) => void;
  /** 划词重写提交：浮动触角输入自由指令后回调（携带当时选区，避免父级 state 漂移）。应为稳定引用。 */
  onRewriteSubmit?: (selection: ProseSelection, instruction: string) => void;
  /** 是否允许划词重写浮动触角（父级在改写/预览进行中可置 false）。缺省 true。 */
  rewriteEnabled?: boolean;
  /** 系统是否要求减弱动画（透传给浮动触角入场动画）。 */
  reducedMotion?: boolean;
  /** 防抖间隔，缺省 1000ms（对齐 EXPERIENCE.md 的 1 秒防抖）。仅挂载时取值——防抖器只创建一次。 */
  debounceMs?: number;
  /** 空文本占位提示。 */
  placeholder?: string;
  /** 无障碍标签（无可见 label）。 */
  ariaLabel?: string;
}

// 贴合内容高度，呈现「白纸」连续页感（外层 StudioShell 负责滚动），避免编辑区内嵌滚动条。
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// —— 镜像量算（DOM 薄壳）—— 把 <textarea> 的盒模型样式克隆进一个隐藏 div，写入「head 文本 + 选区 span +
// tail 文本」，读 span.getClientRects() 取选区每个可视行片段的视口矩形，再经纯函数 selectionRectToContainer
// 换算成「相对编辑器 wrapper」的矩形（高亮叠层 / 浮动触角即按此绝对定位）。textarea 取不到 getRangeAt 矩形，
// 故须镜像；纯坐标算术已下沉单测，此处只做不可单测的 DOM 量算。
function measureSelectionRects(
  textarea: HTMLTextAreaElement,
  container: HTMLElement,
  start: number,
  end: number,
): { rects: SelectionRect[]; anchor: SelectionRect } | null {
  if (typeof document === 'undefined') return null;
  const value = textarea.value;
  const cs = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const ms = mirror.style;
  // 复制影响折行/排版的盒模型样式，保证镜像与 textarea 换行点一致。
  ms.boxSizing = cs.boxSizing;
  ms.width = `${textarea.getBoundingClientRect().width}px`; // 用 border-box 实宽，配合 box-sizing 保内容宽一致
  ms.paddingTop = cs.paddingTop;
  ms.paddingRight = cs.paddingRight;
  ms.paddingBottom = cs.paddingBottom;
  ms.paddingLeft = cs.paddingLeft;
  ms.borderTopWidth = cs.borderTopWidth;
  ms.borderRightWidth = cs.borderRightWidth;
  ms.borderBottomWidth = cs.borderBottomWidth;
  ms.borderLeftWidth = cs.borderLeftWidth;
  ms.borderStyle = 'solid';
  ms.fontFamily = cs.fontFamily;
  ms.fontSize = cs.fontSize;
  ms.fontWeight = cs.fontWeight;
  ms.fontStyle = cs.fontStyle;
  ms.letterSpacing = cs.letterSpacing;
  ms.lineHeight = cs.lineHeight;
  ms.textTransform = cs.textTransform;
  ms.textIndent = cs.textIndent;
  ms.tabSize = cs.tabSize;
  ms.whiteSpace = 'pre-wrap';
  ms.overflowWrap = cs.overflowWrap || 'anywhere';
  ms.wordBreak = cs.wordBreak;
  ms.position = 'absolute';
  ms.top = '0';
  ms.left = '-9999px';
  ms.visibility = 'hidden';
  ms.pointerEvents = 'none';

  mirror.appendChild(document.createTextNode(value.slice(0, start)));
  const span = document.createElement('span');
  span.textContent = value.slice(start, end) || '​';
  mirror.appendChild(span);
  mirror.appendChild(document.createTextNode(value.slice(end)));
  document.body.appendChild(mirror);

  const mirrorRect = mirror.getBoundingClientRect();
  const taRect = textarea.getBoundingClientRect();
  const cRect = container.getBoundingClientRect();
  const rects: SelectionRect[] = Array.from(span.getClientRects())
    .filter((r) => r.width > 0 || r.height > 0)
    .map((r) =>
      selectionRectToContainer({
        rectTop: r.top, rectLeft: r.left, rectWidth: r.width, rectHeight: r.height,
        mirrorTop: mirrorRect.top, mirrorLeft: mirrorRect.left,
        textareaScreenTop: taRect.top, textareaScreenLeft: taRect.left,
        scrollTop: textarea.scrollTop, scrollLeft: textarea.scrollLeft,
        containerScreenTop: cRect.top, containerScreenLeft: cRect.left,
      })
    );
  document.body.removeChild(mirror);
  if (!rects.length) return null;
  return { rects, anchor: rects[0] };
}

function SceneEditorImpl({
  sceneId,
  initialText,
  disabled = false,
  onCommit,
  onSelect,
  onRewriteSubmit,
  rewriteEnabled = true,
  reducedMotion = false,
  debounceMs = 1000,
  placeholder,
  ariaLabel = '正文编辑器',
}: SceneEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 一次性「回声」标记：记录本组件刚写回的值。该值经父级 setSceneTexts 折返成 initialText 时被识别为
  // 「自身回声」并跳过 DOM 写入（值已在 DOM，回灌只会跳光标）；其余 initialText 变化一律按「外部权威新值」处理。
  const echoRef = useRef<string | null>(null);
  // 上一次 sceneId——切换场景一律按「外部新值」走，不让回声判定误吞场景切换。
  const prevSceneIdRef = useRef(sceneId);
  // 高度贴合的 rAF 句柄：合并高频调用（流式逐帧追加 / 连续打字）到下一帧，避免每次都强制同步重排。
  const growRafRef = useRef<number | null>(null);

  // 划词选区（Story 4.2）：本组件内部态，驱动高亮叠层 + 浮动触角定位。空选区/Esc/编辑即清。
  const [selection, setSelection] = useState<ProseSelection | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // 防抖器只创建一次（跨重渲染稳定、保留 pending）。它寿命跨多次渲染，不能闭包某一次的 onCommit，
  // 故经 onCommitRef 桥接到「最新」onCommit（latest-ref；父级本就传稳定引用，双保险）。
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  // onSelect 同理用 latest-ref 桥接，量算副作用里读最新引用。
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const debouncerRef = useRef<Debouncer<string> | null>(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createDebouncer<string>((value) => {
      echoRef.current = value; // 期待此值经父级 state 折返为 initialText → 下次同步 effect 认作回声而跳过
      onCommitRef.current(value);
    }, debounceMs);
  }

  // 高频高度贴合走 rAF 合并：一帧内多次 schedule 只量算一次（流式逐帧追加是真正的热点路径）。
  const requestAutoGrow = () => {
    if (growRafRef.current !== null) return;
    growRafRef.current = requestAnimationFrame(() => {
      growRafRef.current = null;
      if (ref.current) autoGrow(ref.current);
    });
  };

  // 收起划词选区（清高亮 + 触角），并通知父级（更新右栏镜像/兜底）。setSelection 用纯更新器（值未变则 React 自动跳过），
  // 副作用 onSelect(null) 留在更新器外（避免 StrictMode 双调）；父级 setProseSel(null) 幂等，重复调用会被 React bail。
  const clearSelection = useCallback(() => {
    setSelection((prev) => (prev === null ? prev : null));
    onSelectRef.current?.(null);
  }, []);

  // 捕获 textarea 当前选区 → 镜像量算矩形 → 置内部态 + 上抛父级。空选区则收起。
  const captureSelection = useCallback(() => {
    const el = ref.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start === end) { clearSelection(); return; }
    const measured = measureSelectionRects(el, wrap, start, end);
    if (!measured) { clearSelection(); return; }
    const next: ProseSelection = {
      text: el.value.slice(start, end),
      start,
      end,
      rects: measured.rects,
      anchor: measured.anchor,
    };
    setSelection(next);
    onSelectRef.current?.(next);
  }, [clearSelection]);

  // 外部 initialText / sceneId 变化 → 把「自身回声 vs 外部权威新值」交给纯逻辑 resolveExternalSync 判定（已单测）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sceneChanged = prevSceneIdRef.current !== sceneId;
    prevSceneIdRef.current = sceneId;
    const decision = resolveExternalSync({
      initialText, domValue: el.value, echo: echoRef.current, sceneChanged,
    });
    echoRef.current = null; // 本次变化已解析回声预期；echo 仅在防抖写回时重新置位
    if (decision.isEcho) return;
    if (decision.cancelPending) debouncerRef.current?.cancel();
    if (decision.writeDom) {
      el.value = initialText;
      requestAutoGrow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText, sceneId]);

  // 流式生成接管编辑缓冲：禁编瞬间作废任何未触发的本地写回，杜绝其在流式中途回灌污染生成正文。
  // （'fresh' 重写会把 initialText 清空、已由上面的同步 effect 作废；此处兜住 'resume' 等不清空的路径与时序竞态。）
  useEffect(() => {
    if (disabled) {
      debouncerRef.current?.cancel();
      clearSelection(); // 流式禁编期不留划词高亮/触角（AC4b）
    }
  }, [disabled, clearSelection]);

  // 切场景 / 卸载前冲刷待提交值，避免丢掉最后不足 debounceMs 的输入。
  useEffect(() => {
    const debouncer = debouncerRef.current;
    return () => { debouncer?.flush(); };
  }, [sceneId]);

  // 初次挂载贴合高度 + 记录 wrapper 宽度；卸载时取消挂起的高度贴合 rAF。
  useEffect(() => {
    if (ref.current) autoGrow(ref.current);
    if (wrapRef.current) setContainerWidth(wrapRef.current.clientWidth);
    return () => { if (growRafRef.current !== null) cancelAnimationFrame(growRafRef.current); };
  }, []);

  // 窗口尺寸变化时：选区折行会变 → 重新量算高亮/触角；并刷新 wrapper 宽度。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      if (wrapRef.current) setContainerWidth(wrapRef.current.clientWidth);
      if (ref.current && ref.current.selectionStart !== ref.current.selectionEnd) captureSelection();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [captureSelection]);

  const showTrigger = selection !== null && rewriteEnabled && !disabled;

  return (
    <div ref={wrapRef} className="relative">
      <textarea
        ref={ref}
        className="scene-editor"
        defaultValue={initialText}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-busy={disabled}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => {
          if (selection) clearSelection(); // 一旦动笔即收起划词高亮（选区已塌缩）
          debouncerRef.current?.schedule(e.target.value);
          requestAutoGrow();
        }}
        onMouseUp={() => { if (!disabled) captureSelection(); }}
        onKeyUp={(e) => {
          if (disabled) return;
          // 键盘改变选区（Shift+方向 / Home / End / 全选）后捕获；其余键不打扰。
          if (e.shiftKey || e.key === 'Home' || e.key === 'End' || (e.ctrlKey && e.key.toLowerCase() === 'a')) {
            captureSelection();
          }
        }}
        onKeyDown={(e) => { if (e.key === 'Escape' && selection) { e.preventDefault(); clearSelection(); } }}
      />

      {/* 选区高亮叠层（pointer-events:none，不挡输入）：逐可视行片段绘制，失焦后仍可见（不靠 ::selection）。 */}
      {selection?.rects.map((r, i) => (
        <div
          key={i}
          className="highlighted-text"
          style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
        />
      ))}

      {/* 划词重写浮动触角（选区上/下方，placeTrigger 定位）。 */}
      {showTrigger && selection && (
        <FloatingRewriteTrigger
          rect={selection.anchor}
          containerWidth={containerWidth || (wrapRef.current?.clientWidth ?? 0)}
          reducedMotion={reducedMotion}
          onSubmit={(instruction) => onRewriteSubmit?.(selection, instruction)}
          onDismiss={clearSelection}
        />
      )}
    </div>
  );
}

// React.memo（默认浅比较）：父级因 activeCards / 大纲 liveQuery 高频重绘时，本组件 props 值不变即跳过重渲染
// （性能优化）。要求父级把 onCommit/onSelect/onRewriteSubmit 以 useCallback 稳定化；即便偶发重渲染也不伤光标
// （非受控，见文件头 ①），故这里用默认浅比较即可——无需「忽略函数引用」的自定义比较（那会让回调在 memo 跳过
// 渲染时变陈旧）。
const SceneEditor = React.memo(SceneEditorImpl);

export default SceneEditor;
