// 正文编辑器（components/SceneEditor.tsx）的纯逻辑模块。刻意与 React / Dexie / DOM 解耦，便于 node 环境单测
// （范式同 app/outlineOps.ts、app/chapterOps.ts —— 把可单测的算术/时序逻辑下沉成纯函数）。
// 导出两件：① createDebouncer —— 尾沿防抖器；② resolveExternalSync —— 焦点隔离的「回声 vs 外部值」判定（见文末）。
//
// 用途：正文编辑器（components/SceneEditor.tsx）在作者停止输入约 1 秒后，才把最新文本写回，
// 避免每次按键即落盘 / 触发上层重绘（见 project-context.md 的「1 秒防抖」与「正文可达数万字，禁止每次按键即写盘」）。
//
// 语义：
//   schedule(value) —— 安排在 delayMs 后用「最后一次」的 value 调用 fn；其间再次调用会重置计时并覆盖待提交值（只取最后一次）。
//   flush()         —— 若有待提交值，立即同步触发并清空（用于卸载 / 切场景前不丢最后一段输入）。
//   cancel()        —— 丢弃待提交值，不触发（用于外部已接管该值的场景）。
//   pending         —— 是否存在尚未触发的待提交值。
//
// delayMs 缺省 1000（对齐 EXPERIENCE.md 的 1 秒防抖）；负值按 0 处理（仍异步，下一个宏任务触发）。

export interface Debouncer<T> {
  schedule: (value: T) => void;
  flush: () => void;
  cancel: () => void;
  readonly pending: boolean;
}

export function createDebouncer<T>(fn: (value: T) => void, delayMs = 1000): Debouncer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hasPending = false;
  let pendingValue: T | undefined;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // 触发待提交值（若有）。调用方负责先停表；emit 自身只负责「发一次并清空」。
  const emit = () => {
    if (!hasPending) return;
    const value = pendingValue as T;
    hasPending = false;
    pendingValue = undefined;
    fn(value);
  };

  return {
    schedule(value: T) {
      pendingValue = value;
      hasPending = true;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        emit();
      }, Math.max(0, delayMs));
    },
    flush() {
      clearTimer();
      emit();
    },
    cancel() {
      clearTimer();
      hasPending = false;
      pendingValue = undefined;
    },
    get pending() {
      return hasPending;
    },
  };
}

// ——「焦点隔离」核心判定（纯逻辑，便于单测）——
//
// SceneEditor 是非受控 <textarea>：编辑期 DOM 自管 value/光标，只有「外部权威值」变化才该写回 DOM。
// 难点是把两种 initialText 变化区分开：
//   ① 自身防抖写回经父级 setSceneTexts 折返回来的「回声」—— 值已在 DOM，绝不能再写（否则跳光标 / 回灌覆盖输入）；
//   ② 真正的外部新值（切场景/创作、流式增量、接受改写、恢复历史版）—— 须写回 DOM，并作废用户尚未触发的防抖写回
//      （否则陈旧缓冲会在 1s 后回灌，污染流式正文 / 把上一处创作的文本串写到另一处）。
// 用「一次性回声值」echo 精确匹配①；其余皆按②。切场景（sceneChanged）一律按②，不让回声判定误吞场景切换。
//
// 关键不变量：外部值取代缓冲时必须 cancelPending=true（这正是 review 修复的 #1 流式污染 / #2 跨创作串写的根因）。

export interface ExternalSyncInput {
  /** 外部权威文本（= 父级传入的 initialText）。 */
  initialText: string;
  /** 当前 textarea 的 DOM 值。 */
  domValue: string;
  /** 上次自身写回、尚待经父级 state 折返的「回声值」；无则 null。 */
  echo: string | null;
  /** 本次同步是否伴随 sceneId 切换。 */
  sceneChanged: boolean;
}

export interface ExternalSyncDecision {
  /** 判为自身回声：跳过 DOM 同步，且不作废可能新一轮的 pending。 */
  isEcho: boolean;
  /** 作废用户尚未触发的防抖写回（外部值已取代本地缓冲）。 */
  cancelPending: boolean;
  /** 把 initialText 写进 DOM（仅当与当前 DOM 值不同，免去无谓写入 / 跳光标）。 */
  writeDom: boolean;
}

// 调用方在每次 initialText/sceneId 变化的 effect 里调用本函数，并据结果操作 DOM/防抖器；
// 无论结果如何，调用方都应把 echo 置空（本次变化已解析该回声预期，echo 仅由防抖写回时重新置位）。
export function resolveExternalSync(input: ExternalSyncInput): ExternalSyncDecision {
  const { initialText, domValue, echo, sceneChanged } = input;
  // ① 自身回声（且非切场景）：值已在 DOM，跳过；不 cancel（保留用户回声后又新输入产生的 pending）。
  if (!sceneChanged && echo !== null && initialText === echo) {
    return { isEcho: true, cancelPending: false, writeDom: false };
  }
  // ② 外部权威新值：作废挂起写回；仅当 DOM 与新值不同才写。
  return { isEcho: false, cancelPending: true, writeDom: initialText !== domValue };
}
