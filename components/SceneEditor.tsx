'use client';

// 成稿开篇的可编辑正文区（Story 4.1 · FR-EDIT）。核心诉求：当侧栏大纲 / 设定卡在后台刷新
// （useLiveQuery 重绘）时，绝不打断作者的打字光标与选区。实现路径（见 4.1 Dev Notes「焦点隔离」）：
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

import React, { useEffect, useRef } from 'react';
import { createDebouncer, resolveExternalSync, type Debouncer } from '../app/editorOps';

interface SceneEditorProps {
  /** 场景标识；变化即视为切换场景，强制按「外部新值」重载文本（本故事恒为开篇 OPENING_SCENE_NUM）。 */
  sceneId: number | string;
  /** 外部权威文本（= sceneTexts[OPENING_SCENE_NUM]）；流式 / 改写 / 恢复历史版会改变它。 */
  initialText: string;
  /** 流式生成中禁编（仍展示流式增长的文本）。 */
  disabled?: boolean;
  /** 防抖写回：停止输入 debounceMs 后用最新文本调用。应为稳定引用（父级 useCallback）。 */
  onCommit: (text: string) => void;
  /** 选区回调（onMouseUp 透传）：传出 textarea 当前选中的文本，供选句改写 / 4.2 划词定位预留。应为稳定引用。 */
  onSelect?: (selectedText: string) => void;
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

function SceneEditorImpl({
  sceneId,
  initialText,
  disabled = false,
  onCommit,
  onSelect,
  debounceMs = 1000,
  placeholder,
  ariaLabel = '正文编辑器',
}: SceneEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // 一次性「回声」标记：记录本组件刚写回的值。该值经父级 setSceneTexts 折返成 initialText 时被识别为
  // 「自身回声」并跳过 DOM 写入（值已在 DOM，回灌只会跳光标）；其余 initialText 变化一律按「外部权威新值」处理。
  const echoRef = useRef<string | null>(null);
  // 上一次 sceneId——切换场景一律按「外部新值」走，不让回声判定误吞场景切换。
  const prevSceneIdRef = useRef(sceneId);
  // 高度贴合的 rAF 句柄：合并高频调用（流式逐帧追加 / 连续打字）到下一帧，避免每次都强制同步重排。
  const growRafRef = useRef<number | null>(null);

  // 防抖器只创建一次（跨重渲染稳定、保留 pending）。它寿命跨多次渲染，不能闭包某一次的 onCommit，
  // 故经 onCommitRef 桥接到「最新」onCommit（latest-ref；父级本就传稳定引用，双保险）。
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

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
    if (disabled) debouncerRef.current?.cancel();
  }, [disabled]);

  // 切场景 / 卸载前冲刷待提交值，避免丢掉最后不足 debounceMs 的输入。
  useEffect(() => {
    const debouncer = debouncerRef.current;
    return () => { debouncer?.flush(); };
  }, [sceneId]);

  // 初次挂载贴合高度；卸载时取消挂起的高度贴合 rAF。
  useEffect(() => {
    if (ref.current) autoGrow(ref.current);
    return () => { if (growRafRef.current !== null) cancelAnimationFrame(growRafRef.current); };
  }, []);

  return (
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
        debouncerRef.current?.schedule(e.target.value);
        requestAutoGrow();
      }}
      onMouseUp={(e) => {
        if (disabled) return;
        const el = e.currentTarget;
        onSelect?.(el.value.substring(el.selectionStart ?? 0, el.selectionEnd ?? 0));
      }}
    />
  );
}

// React.memo（默认浅比较）：父级因 activeCards / 大纲 liveQuery 高频重绘时，本组件 props 值不变即跳过重渲染
// （性能优化）。要求父级把 onCommit/onSelect 以 useCallback 稳定化；即便偶发重渲染也不伤光标（非受控，见文件头 ①），
// 故这里用默认浅比较即可——无需「忽略函数引用」的自定义比较（那会让 onSelect 等回调在 memo 跳过渲染时变陈旧）。
const SceneEditor = React.memo(SceneEditorImpl);

export default SceneEditor;
