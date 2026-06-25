// 开篇快照栈（FusionSession.openingDrafts）的纯逻辑模块。刻意与 React / Dexie / DOM 解耦，便于 node 环境单测
// （范式同 app/editorOps.ts、app/outlineOps.ts、app/chapterOps.ts —— 把可单测的栈运算下沉成纯函数）。
//
// 背景：成稿步骤「重写开篇 / 划词接受 / 回滚」三处归档点此前各自内联 `[{text,createdAt},...prev].slice(0, 5)`，
// 上限散落（魔法数字 5）且快照无版本号。Story 4.3 把这套运算下沉到此：统一 10 上限、补单调递增的
// `Version N` 标签、复刻回滚时的栈重排语义（当前正文先归档、被取版本移除、当前永不出现在历史列表）。
//
// 载体决策（Story 4.3 决策①）：复用扩展既有 openingDrafts 栈，不接 v16 draftHistory 表——后者主键 sceneId
// 指向 FR-MEM「幕」表，成稿开篇用合成 OPENING_SCENE_NUM 在该表无对应行。`import type` 为类型擦除（不触发
// new NovelFusionDB()），故本模块仍可在 node 纯逻辑单测（同 app/dnaState.ts 的 `import type … from './db'` 先例）。

import type { OpeningDraft } from './db';

// 开篇快照上限（FR-EDT-003）。与 memorySchema 的 DRAFT_HISTORY_MAX_PER_SCENE 同值 10，但语义独立
// （那条属 FR-MEM「幕」级编辑器）；此处单列一个常量收口，杜绝三处归档点散落的魔法数字 5/10。
export const OPENING_DRAFTS_MAX = 10;

const VERSION_LABEL_RE = /^Version\s+(\d+)$/;

// 解析 "Version N" → N（正整数）；非该格式 / 缺省 label 返回 0。
function parseVersionNumber(label?: string): number {
  if (!label) return 0;
  const m = VERSION_LABEL_RE.exec(label.trim());
  return m ? Number(m[1]) : 0;
}

// 为「下一条新快照」生成单调递增的 Version 标签：取栈中已用最大编号 +1。
// 单调性保证：最新快照永远置于栈首、汰旧只 slice 掉栈尾最旧的（编号最小），故最大编号恒被保留，
// 编号只增不复用（避免「汰旧后旧号被重新发出」造成的版本心智混乱，见 Dev Notes 推荐的单调递增策略）。
// 栈内无任何带号标签时（全为 v12 legacy 无 label 快照）从 length+1 起——使新号高于 displayLabel 的位次回退
// （1..length），避免显示冲突；空栈则 Version 1。
export function nextVersionLabel(stack: OpeningDraft[]): string {
  const maxUsed = stack.reduce((mx, d) => Math.max(mx, parseVersionNumber(d.label)), 0);
  return `Version ${maxUsed > 0 ? maxUsed + 1 : stack.length + 1}`;
}

// 展示用标签：优先用已存 label；legacy（v12 无 label）按位次回退（最新数字最大；当前不在列表里）。
export function displayLabel(stack: OpeningDraft[], idx: number): string {
  return stack[idx]?.label || `Version ${stack.length - idx}`;
}

// 归档一条快照到栈首：
// - 空白文本（`!text.trim()`）原样返回**同一引用**（不入栈，避免空版污染历史；让 React setState 自动 bail-out）；
// - 否则把 {text, createdAt, label} 置于栈首并裁剪到 OPENING_DRAFTS_MAX（超出自动汰最旧/栈尾）。
export function pushSnapshot(stack: OpeningDraft[], text: string, createdAt: number): OpeningDraft[] {
  if (!text.trim()) return stack;
  return [{ text, createdAt, label: nextVersionLabel(stack) }, ...stack].slice(0, OPENING_DRAFTS_MAX);
}

// 回滚到第 idx 条历史版（复刻 FusionWorkshop.restoreOpeningDraft 既有语义）：
// - idx 越界 / 栈空 → 返回 null（调用方据此不动正文与栈）；
// - restored = 被选版正文（将成为新「当前」）；
// - 当前正文（若非空）先归档回栈首，带新 Version 号——编号取自**含被选版的完整栈**最大值 +1，
//   确保即便回滚的正是最新版，新归档也不复用其编号；
// - 被选版从列表移除（沿用既有语义：「当前」永不出现在历史列表）；最后裁剪到上限。
export function restoreSnapshot(
  stack: OpeningDraft[],
  idx: number,
  currentText: string,
  createdAt: number,
): { next: OpeningDraft[]; restored: string } | null {
  const target = stack[idx];
  if (!target) return null;
  const remaining = stack.filter((_, i) => i !== idx);
  const next = currentText.trim()
    ? [{ text: currentText, createdAt, label: nextVersionLabel(stack) }, ...remaining].slice(0, OPENING_DRAFTS_MAX)
    : remaining.slice(0, OPENING_DRAFTS_MAX);
  return { next, restored: target.text };
}
