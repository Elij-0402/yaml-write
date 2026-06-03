// 设定块「旧 vs 新」字符级 diff（纯函数，无依赖；在 diff.test.ts 以 node 环境单测）。
// 供创世台把 AI 改动渲染成绿增红删，再由用户接受/拒绝（严禁静默覆盖）。中文按 code point 逐字比对。

export type DiffOp = 'equal' | 'add' | 'remove';
export interface DiffSegment {
  op: DiffOp;
  text: string;
}

// 设定块通常很短；超过此长度退化为「整体替换」，避免 O(n*m) LCS 的内存/耗时尖峰。
const COARSE_THRESHOLD = 3000;

export function computeDiff(oldText: string, newText: string): DiffSegment[] {
  const a = Array.from(oldText); // code-point 感知（中文/emoji 安全）
  const b = Array.from(newText);
  if (a.length === 0 && b.length === 0) return [];

  if (a.length > COARSE_THRESHOLD || b.length > COARSE_THRESHOLD) {
    const segs: DiffSegment[] = [];
    if (oldText) segs.push({ op: 'remove', text: oldText });
    if (newText) segs.push({ op: 'add', text: newText });
    return segs;
  }

  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // LCS 长度表（自底向上）。值 ≤ min(n,m) ≤ 3000，Uint16 足够。
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (op: DiffOp, ch: string) => {
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.text += ch;
    else segments.push({ op, text: ch });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      push('remove', a[i]);
      i += 1;
    } else {
      push('add', b[j]);
      j += 1;
    }
  }
  while (i < n) { push('remove', a[i]); i += 1; }
  while (j < m) { push('add', b[j]); j += 1; }
  return segments;
}

// 是否存在实质改动（用于决定是否需要让用户确认）。
export function hasChange(segments: DiffSegment[]): boolean {
  return segments.some((s) => s.op !== 'equal');
}
