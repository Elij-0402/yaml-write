// 划词改写（Story 4.2 · FR-EDT-002）的纯逻辑模块。刻意与 React / DOM 解耦，便于 node 环境单测
// （范式同 app/editorOps.ts、app/outlineOps.ts —— 把可单测的算术下沉成纯函数）。导出四件：
//   ① spliceRange         —— 按字符索引区间替换（AC3：杜绝 String.replace 首次匹配误伤同句）；
//   ② isRangeIntact       —— 接受改写前的区间一致性校验（文本漂移则调用方安全回退，绝不盲替）；
//   ③ placeTrigger        —— 浮动触角的上/下方位翻转 + 水平钳制（纯几何判定）；
//   ④ selectionRectToContainer —— 镜像 div 量算出的选区视口矩形 → 编辑器容器相对坐标的换算。
//
// DOM 量算（克隆 <textarea> 盒模型的隐藏镜像 div、写入 value.slice(0,start)+选区 span、读 getClientRects）
// 是不可单测的副作用，留在 SceneEditor 薄壳；本模块只承接其产出的数字做纯算术。

export interface SelectionRect {
  /** 相对编辑器定位容器左上角的纵向偏移（px）。 */
  top: number;
  /** 横向偏移（px）。 */
  left: number;
  /** top + height，便于「下方」锚定。 */
  bottom: number;
  /** 该可视行片段高度（≈ 行高，px）。 */
  height: number;
  /** 该可视行片段宽度（px）。 */
  width: number;
}

// SceneEditor 选区回调（onSelect）传出的结构化选区。start/end 为 textarea 字符索引（接受时做区间替换）。
export interface ProseSelection {
  /** 选中子串（已 trim 前的原始子串；父级按需 trim）。 */
  text: string;
  /** 选区起点字符索引（textarea.selectionStart）。 */
  start: number;
  /** 选区终点字符索引（textarea.selectionEnd）。 */
  end: number;
  /** 选区每个可视行片段的矩形（容器相对）；单行 → 1 个，换行 → 多个（高亮叠层逐块绘制）。 */
  rects: SelectionRect[];
  /** 选区起点行矩形（浮动触角 / 行内预览的锚点）。 */
  anchor: SelectionRect;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ① 按「捕获的字符索引」替换区间 —— AC3 核心。替代 acceptFragment 旧的 String.replace(original) 首次匹配
//    （同句在全篇出现多次时会误伤到错误的那一处）。越界钳制、start>end 自动交换，保证纯函数永不抛错。
export function spliceRange(text: string, start: number, end: number, replacement: string): string {
  const len = text.length;
  let s = clamp(Math.trunc(start), 0, len);
  let e = clamp(Math.trunc(end), 0, len);
  if (s > e) [s, e] = [e, s];
  return text.slice(0, s) + replacement + text.slice(e);
}

// ② 接受前的安全校验：改写期间作者被切到只读预览（无法再编辑正文），start/end 理应仍与正文一致；
//    若不一致（时序竞态 / 文本漂移），调用方应回退到「按原文唯一匹配才替换，否则提示重选」，绝不盲替。
export function isRangeIntact(text: string, start: number, end: number, expected: string): boolean {
  const len = text.length;
  const s = clamp(Math.trunc(start), 0, len);
  const e = clamp(Math.trunc(end), 0, len);
  return text.slice(s, e) === expected;
}

export interface PlaceTriggerInput {
  /** 选区起点行矩形 top（容器相对）。 */
  anchorTop: number;
  /** 选区起点行矩形 left（容器相对）。 */
  anchorLeft: number;
  /** 选区起点行高度。 */
  anchorHeight: number;
  /** 触角自身宽度（组件量算后传入）。 */
  triggerWidth: number;
  /** 触角自身高度。 */
  triggerHeight: number;
  /** 容器可用宽度（水平钳制上界）。 */
  containerWidth: number;
  /** 触角与选区的垂直间隙。 */
  gap: number;
}
export interface TriggerPlacement {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

// ③ 默认把触角置于选区**上方**；上方空间不足（放不下「触角高 + 间隙」）则翻到**下方**。
//    水平锚到选区起点并钳制在 [0, containerWidth - triggerWidth] 内，避免溢出编辑器。
export function placeTrigger(input: PlaceTriggerInput): TriggerPlacement {
  const { anchorTop, anchorLeft, anchorHeight, triggerWidth, triggerHeight, containerWidth, gap } = input;
  const fitsAbove = anchorTop >= triggerHeight + gap;
  const placement: 'above' | 'below' = fitsAbove ? 'above' : 'below';
  const top = fitsAbove ? anchorTop - triggerHeight - gap : anchorTop + anchorHeight + gap;
  const maxLeft = Math.max(0, containerWidth - triggerWidth);
  const left = clamp(anchorLeft, 0, maxLeft);
  return { top, left, placement };
}

export interface SelectionRectToContainerInput {
  /** 镜像内选区片段的视口矩形（getClientRects 产出）。 */
  rectTop: number; rectLeft: number; rectWidth: number; rectHeight: number;
  /** 镜像 div 的视口原点（getBoundingClientRect().top/left）。 */
  mirrorTop: number; mirrorLeft: number;
  /** 真实 textarea 的视口原点。 */
  textareaScreenTop: number; textareaScreenLeft: number;
  /** textarea 当前滚动量（长文滚动时选区随之上移）。 */
  scrollTop: number; scrollLeft: number;
  /** 定位容器（编辑器 wrapper）的视口原点。 */
  containerScreenTop: number; containerScreenLeft: number;
}

// ④ 镜像量算视口矩形 → 容器相对坐标。镜像与 textarea 盒模型一致：片段相对镜像 border-box 的偏移
//    （rect − mirror）即等于其相对 textarea border-box 的偏移；叠加 textarea 屏幕位、扣除滚动得到选区在
//    页面中的真实屏幕坐标；再减容器屏幕原点 → 容器相对坐标（高亮叠层 / 触角 / 预览即按此绝对定位）。
export function selectionRectToContainer(input: SelectionRectToContainerInput): SelectionRect {
  const screenTop = input.textareaScreenTop + (input.rectTop - input.mirrorTop) - input.scrollTop;
  const screenLeft = input.textareaScreenLeft + (input.rectLeft - input.mirrorLeft) - input.scrollLeft;
  const top = screenTop - input.containerScreenTop;
  const left = screenLeft - input.containerScreenLeft;
  return { top, left, width: input.rectWidth, height: input.rectHeight, bottom: top + input.rectHeight };
}
