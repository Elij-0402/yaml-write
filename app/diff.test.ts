import { describe, it, expect } from 'vitest';
import { computeDiff, hasChange, type DiffSegment } from './diff';

// 不变量：把非 remove 段拼起来 = 新文本；把非 add 段拼起来 = 旧文本。
const reconstructNew = (segs: DiffSegment[]) => segs.filter((s) => s.op !== 'remove').map((s) => s.text).join('');
const reconstructOld = (segs: DiffSegment[]) => segs.filter((s) => s.op !== 'add').map((s) => s.text).join('');

describe('computeDiff', () => {
  it('returns no segments for two empty strings', () => {
    expect(computeDiff('', '')).toEqual([]);
  });

  it('marks an identical string entirely equal', () => {
    expect(computeDiff('天道修行', '天道修行')).toEqual([{ op: 'equal', text: '天道修行' }]);
  });

  it('represents a pure insertion as equal + add', () => {
    const segs = computeDiff('灵气复苏', '灵气彻底复苏');
    expect(hasChange(segs)).toBe(true);
    expect(reconstructOld(segs)).toBe('灵气复苏');
    expect(reconstructNew(segs)).toBe('灵气彻底复苏');
    expect(segs.some((s) => s.op === 'add')).toBe(true);
    expect(segs.some((s) => s.op === 'remove')).toBe(false);
  });

  it('represents a pure deletion as equal + remove', () => {
    const segs = computeDiff('灵气彻底复苏', '灵气复苏');
    expect(reconstructOld(segs)).toBe('灵气彻底复苏');
    expect(reconstructNew(segs)).toBe('灵气复苏');
    expect(segs.some((s) => s.op === 'remove')).toBe(true);
    expect(segs.some((s) => s.op === 'add')).toBe(false);
  });

  it('represents a middle replacement and preserves the reconstruct invariants', () => {
    const oldText = '主角是废柴少年';
    const newText = '主角是天才少女';
    const segs = computeDiff(oldText, newText);
    expect(reconstructOld(segs)).toBe(oldText);
    expect(reconstructNew(segs)).toBe(newText);
    expect(segs.some((s) => s.op === 'equal')).toBe(true); // 「主角是」「少」保留
  });

  it('handles empty old (all add) and empty new (all remove)', () => {
    expect(computeDiff('', '新增设定')).toEqual([{ op: 'add', text: '新增设定' }]);
    expect(computeDiff('旧设定', '')).toEqual([{ op: 'remove', text: '旧设定' }]);
  });

  it('falls back to whole-block replace beyond the coarse threshold', () => {
    const big = '甲'.repeat(3100);
    const big2 = '乙'.repeat(3100);
    const segs = computeDiff(big, big2);
    expect(segs).toEqual([{ op: 'remove', text: big }, { op: 'add', text: big2 }]);
  });
});

describe('hasChange', () => {
  it('is false when everything is equal', () => {
    expect(hasChange(computeDiff('abc', 'abc'))).toBe(false);
  });
  it('is true when there is any add or remove', () => {
    expect(hasChange(computeDiff('abc', 'abd'))).toBe(true);
  });
});
