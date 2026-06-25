import { describe, it, expect } from 'vitest';
import {
  OPENING_DRAFTS_MAX,
  nextVersionLabel,
  displayLabel,
  pushSnapshot,
  restoreSnapshot,
} from './draftSnapshots';
import type { OpeningDraft } from './db';

// 开篇快照栈纯逻辑单测（node 环境，无 React/Dexie/DOM）。覆盖 AC1（空文本不入栈、10 上限汰旧、Version 标签）、
// AC2（回滚后「当前不在列表」+ 栈不超限）与 Dev Notes 的单调递增编号策略（汰旧/回滚后不复用旧号）。

// 构造一条快照（label 可选——缺省即模拟 v12 legacy 无 label 快照）。
const d = (text: string, createdAt = 0, label?: string): OpeningDraft => ({ text, createdAt, label });
const num = (label?: string): number => Number((label || '').split(' ')[1]);

describe('OPENING_DRAFTS_MAX', () => {
  it('开篇快照上限为 10（FR-EDT-003；收口三处归档点的魔法数字）', () => {
    expect(OPENING_DRAFTS_MAX).toBe(10);
  });
});

describe('pushSnapshot', () => {
  it('空 / 纯空白文本不入栈，且返回同一引用（让 React setState 自动 bail，不产生空版污染）', () => {
    const stack = [d('a', 1, 'Version 1')];
    expect(pushSnapshot(stack, '', 5)).toBe(stack);
    expect(pushSnapshot(stack, '   \n\t ', 5)).toBe(stack);
  });

  it('正常入栈：最新置顶，带 createdAt 与 Version 标签', () => {
    const next = pushSnapshot([], 'first', 100);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ text: 'first', createdAt: 100, label: 'Version 1' });
  });

  it('连续归档：编号单调递增、最新置顶（不按数组位次）', () => {
    let s: OpeningDraft[] = [];
    s = pushSnapshot(s, 'a', 1);
    s = pushSnapshot(s, 'b', 2);
    s = pushSnapshot(s, 'c', 3);
    expect(s.map((x) => x.label)).toEqual(['Version 3', 'Version 2', 'Version 1']);
    expect(s.map((x) => x.text)).toEqual(['c', 'b', 'a']);
  });

  it('恰好 10 条不汰旧；第 11 条挤掉最早的一条（栈尾），栈长仍为 10（AC1b 汰旧）', () => {
    let s: OpeningDraft[] = [];
    for (let i = 1; i <= 10; i++) s = pushSnapshot(s, `t${i}`, i);
    expect(s).toHaveLength(10);
    expect(s[0].label).toBe('Version 10');
    expect(s[9].label).toBe('Version 1'); // 最旧在栈尾

    s = pushSnapshot(s, 't11', 11);
    expect(s).toHaveLength(10); // 仍为 10
    expect(s[0].label).toBe('Version 11'); // 新版置顶
    expect(s.find((x) => x.text === 't1')).toBeUndefined(); // 最早被丢弃
    expect(s[9].label).toBe('Version 2'); // 现存最旧
  });

  it('汰旧后编号不复用：连续超限仍严格单调递增（Dev Notes 推荐策略）', () => {
    let s: OpeningDraft[] = [];
    for (let i = 1; i <= 12; i++) s = pushSnapshot(s, `t${i}`, i);
    expect(s.map((x) => num(x.label))).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it('legacy 无 label 快照在前：新归档编号高于位次回退，避免与 displayLabel 冲突', () => {
    const legacy = [d('a'), d('b'), d('c')]; // 三条无 label
    const s = pushSnapshot(legacy, 'd', 9);
    expect(s[0].label).toBe('Version 4'); // length(3)+1
  });
});

describe('nextVersionLabel', () => {
  it('空栈 → Version 1', () => {
    expect(nextVersionLabel([])).toBe('Version 1');
  });
  it('取已用最大编号 +1（跳号也认最大，不按长度）', () => {
    expect(nextVersionLabel([d('a', 1, 'Version 7'), d('b', 2, 'Version 3')])).toBe('Version 8');
  });
  it('legacy 无 label 栈 → length+1', () => {
    expect(nextVersionLabel([d('a'), d('b'), d('c')])).toBe('Version 4');
  });
});

describe('displayLabel', () => {
  it('优先用已存 label', () => {
    expect(displayLabel([d('a', 1, 'Version 9')], 0)).toBe('Version 9');
  });
  it('legacy 无 label：按位次回退（最新数字最大）', () => {
    const s = [d('x'), d('y'), d('z')];
    expect(displayLabel(s, 0)).toBe('Version 3');
    expect(displayLabel(s, 2)).toBe('Version 1');
  });
});

describe('restoreSnapshot', () => {
  it('越界 idx / 空栈 → null（调用方据此不动正文与栈）', () => {
    expect(restoreSnapshot([], 0, 'cur', 1)).toBeNull();
    expect(restoreSnapshot([d('a', 1, 'Version 1')], 5, 'cur', 1)).toBeNull();
  });

  it('restored = 被选版正文；当前非空归档回栈首；被选版移除（当前不在列表，AC2c）', () => {
    const s = [d('A', 1, 'Version 3'), d('B', 2, 'Version 2'), d('C', 3, 'Version 1')];
    const r = restoreSnapshot(s, 1, 'CUR', 9)!; // 回滚到 B
    expect(r.restored).toBe('B');
    expect(r.next[0]).toEqual({ text: 'CUR', createdAt: 9, label: 'Version 4' }); // 当前归档、max(3)+1
    expect(r.next.map((x) => x.text)).toEqual(['CUR', 'A', 'C']); // B 已移除
    expect(r.next.some((x) => x.text === 'B')).toBe(false);
  });

  it('当前为空白：不归档，仅移除被选版', () => {
    const s = [d('A', 1, 'Version 2'), d('B', 2, 'Version 1')];
    const r = restoreSnapshot(s, 0, '   ', 9)!;
    expect(r.restored).toBe('A');
    expect(r.next.map((x) => x.text)).toEqual(['B']);
  });

  it('回滚最新版也不复用其编号（编号取自含被选版的完整栈最大值 +1）', () => {
    const s = [d('A', 1, 'Version 3'), d('B', 2, 'Version 2'), d('C', 3, 'Version 1')];
    const r = restoreSnapshot(s, 0, 'CUR', 9)!; // 回滚最新 V3
    expect(r.restored).toBe('A');
    expect(r.next[0].label).toBe('Version 4'); // 不复用 3
    expect(r.next.map((x) => x.text)).toEqual(['CUR', 'B', 'C']);
  });

  it('满栈回滚 + 当前归档：栈长仍不超上限（AC2c 栈不超限）', () => {
    let s: OpeningDraft[] = [];
    for (let i = 1; i <= 10; i++) s = pushSnapshot(s, `t${i}`, i); // 满 10
    const r = restoreSnapshot(s, 9, 'CUR', 99)!; // 回滚最旧（栈尾）
    expect(r.next).toHaveLength(10); // 当前归档 +1、移除被选 -1 → 仍 10
    expect(r.restored).toBe('t1');
    expect(r.next[0].label).toBe('Version 11'); // 单调递增
  });
});
