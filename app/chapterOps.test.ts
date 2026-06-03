import { describe, it, expect } from 'vitest';
import {
  planStitch,
  planBulkStitch,
  planSplit,
  buildStitchBackup,
  type ChapterLike,
} from './chapterOps';

const ch = (id: string, chapterIndex: number, content: string, name = id): ChapterLike =>
  ({ id, chapterIndex, name, content });

// 顺序章节，下标 1..n，正文取 id 大写便于断言拼接。
const seq = (...ids: string[]): ChapterLike[] => ids.map((id, i) => ch(id, i + 1, id.toUpperCase()));

describe('planStitch', () => {
  it('merges a chapter into its predecessor and shifts later indices down by 1', () => {
    const plan = planStitch(seq('a', 'b', 'c', 'd'), 'b');
    expect(plan).not.toBeNull();
    expect(plan!.keepId).toBe('a');
    expect(plan!.removeId).toBe('b');
    expect(plan!.mergedContent).toBe('A\n\nB');
    // c(idx3)->2, d(idx4)->3
    expect(plan!.reindex).toEqual([{ id: 'c', chapterIndex: 2 }, { id: 'd', chapterIndex: 3 }]);
  });

  it('refuses the first chapter (cannot stitch backwards) and unknown ids', () => {
    expect(planStitch(seq('a', 'b'), 'a')).toBeNull();
    expect(planStitch(seq('a', 'b'), 'zzz')).toBeNull();
  });

  it('produces an empty reindex when stitching the last chapter', () => {
    const plan = planStitch(seq('a', 'b', 'c'), 'c');
    expect(plan!.keepId).toBe('b');
    expect(plan!.reindex).toEqual([]);
  });
});

describe('planBulkStitch', () => {
  it('merges a run of selected chapters into the preceding kept chapter', () => {
    const plan = planBulkStitch(seq('a', 'b', 'c', 'd'), new Set(['b', 'c']));
    expect(plan.removeIds).toEqual(['b', 'c']);
    expect(plan.merges).toEqual([{ keepId: 'a', mergedContent: 'A\n\nB\n\nC' }]);
    // remaining a,d -> 1,2
    expect(plan.reindex).toEqual([{ id: 'a', chapterIndex: 1 }, { id: 'd', chapterIndex: 2 }]);
  });

  it('handles non-contiguous selections with separate anchors', () => {
    const plan = planBulkStitch(seq('a', 'b', 'c', 'd'), new Set(['b', 'd']));
    expect(plan.removeIds).toEqual(['b', 'd']);
    expect(plan.merges).toEqual([
      { keepId: 'a', mergedContent: 'A\n\nB' },
      { keepId: 'c', mergedContent: 'C\n\nD' },
    ]);
    expect(plan.reindex).toEqual([{ id: 'a', chapterIndex: 1 }, { id: 'c', chapterIndex: 2 }]);
  });

  it('never removes the first chapter even if it is selected', () => {
    const plan = planBulkStitch(seq('a', 'b'), new Set(['a', 'b']));
    expect(plan.removeIds).toEqual(['b']);
    expect(plan.merges).toEqual([{ keepId: 'a', mergedContent: 'A\n\nB' }]);
  });

  it('accumulates a long chained run onto a single anchor', () => {
    const plan = planBulkStitch(seq('a', 'b', 'c', 'd'), new Set(['b', 'c', 'd']));
    expect(plan.removeIds).toEqual(['b', 'c', 'd']);
    expect(plan.merges).toEqual([{ keepId: 'a', mergedContent: 'A\n\nB\n\nC\n\nD' }]);
    expect(plan.reindex).toEqual([{ id: 'a', chapterIndex: 1 }]);
  });
});

describe('planSplit', () => {
  it('splits a chapter by line index, trims halves, names the lower part, shifts later indices up', () => {
    const chapters = [ch('a', 1, 'l0\nl1\nl2\nl3'), ch('b', 2, 'B'), ch('c', 3, 'C')];
    const plan = planSplit(chapters[0], 1, chapters);
    expect(plan.contentA).toBe('l0\nl1');
    expect(plan.contentB).toBe('l2\nl3');
    expect(plan.newName).toBe('a (下)');
    expect(plan.newChapterIndex).toBe(2);
    expect(plan.reindex).toEqual([{ id: 'b', chapterIndex: 3 }, { id: 'c', chapterIndex: 4 }]);
  });
});

describe('buildStitchBackup', () => {
  it('captures every chapter id->index and passes affected chapters through verbatim', () => {
    const chapters = seq('a', 'b', 'c');
    const affected = [chapters[0], chapters[1]];
    const backup = buildStitchBackup(chapters, 'novel-1', affected);
    expect(backup.novelId).toBe('novel-1');
    expect(backup.tocMap).toEqual({ a: 1, b: 2, c: 3 });
    expect(backup.affectedChapters).toBe(affected);
  });
});
