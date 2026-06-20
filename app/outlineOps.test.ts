import { describe, it, expect } from 'vitest';
import {
  nextOrder,
  planReorder,
  reindexSiblings,
  collectCascade,
  buildOutlineTree,
} from './outlineOps';
import type { Volume, OutlineChapter, Scene } from './memorySchema';

// —— 测试工厂：只填影响逻辑的字段，其余给确定缺省（本模块纯逻辑只读 id/父键/order）——
const vol = (id: string, order: number, novelId = 'n1'): Volume =>
  ({ id, novelId, title: id, order, createdAt: 0, updatedAt: 0 });
const chap = (id: string, volumeId: string, order: number, novelId = 'n1'): OutlineChapter =>
  ({ id, novelId, volumeId, title: id, order, createdAt: 0, updatedAt: 0 });
const scene = (id: string, chapterId: string, order: number, novelId = 'n1'): Scene =>
  ({ id, novelId, chapterId, title: id, order, synopsis: '', content: '', wordCount: 0, createdAt: 0, updatedAt: 0 });

describe('nextOrder', () => {
  it('returns the start value (0) for an empty sibling set', () => {
    expect(nextOrder([])).toBe(0);
  });

  it('returns max(order) + 1 for a non-empty set (gaps & unsorted tolerated)', () => {
    expect(nextOrder([{ order: 0 }, { order: 1 }, { order: 2 }])).toBe(3);
    expect(nextOrder([{ order: 5 }, { order: 2 }])).toBe(6);
    expect(nextOrder([{ order: 0 }])).toBe(1);
  });
});

describe('planReorder', () => {
  const sibs = [
    { id: 'a', order: 0 },
    { id: 'b', order: 1 },
    { id: 'c', order: 2 },
    { id: 'd', order: 3 },
  ];

  it('moves an item forward (later index) and renumbers to a contiguous 0..n-1 sequence', () => {
    // a,b,c,d → move a to index 2 → b,c,a,d
    expect(planReorder(sibs, 'a', 2)).toEqual([
      { id: 'b', order: 0 },
      { id: 'c', order: 1 },
      { id: 'a', order: 2 },
      { id: 'd', order: 3 },
    ]);
  });

  it('moves an item backward (earlier index)', () => {
    // a,b,c,d → move d to index 0 → d,a,b,c
    expect(planReorder(sibs, 'd', 0)).toEqual([
      { id: 'd', order: 0 },
      { id: 'a', order: 1 },
      { id: 'b', order: 2 },
      { id: 'c', order: 3 },
    ]);
  });

  it('clamps an out-of-range target index to the last position', () => {
    // move a to index 99 → b,c,d,a
    expect(planReorder(sibs, 'a', 99)).toEqual([
      { id: 'b', order: 0 },
      { id: 'c', order: 1 },
      { id: 'd', order: 2 },
      { id: 'a', order: 3 },
    ]);
  });

  it('respects current order (not input order) when computing positions', () => {
    const unsorted = [
      { id: 'c', order: 2 },
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ];
    // visual order a,b,c → move c to index 0 → c,a,b
    expect(planReorder(unsorted, 'c', 0)).toEqual([
      { id: 'c', order: 0 },
      { id: 'a', order: 1 },
      { id: 'b', order: 2 },
    ]);
  });

  it('falls back to a plain compaction when movedId is not in the group', () => {
    const gapped = [
      { id: 'a', order: 0 },
      { id: 'b', order: 5 },
    ];
    expect(planReorder(gapped, 'zzz', 0)).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ]);
  });
});

describe('reindexSiblings', () => {
  it('compacts gappy orders into a contiguous 0..n-1 sequence (sorted by order)', () => {
    const gapped = [
      { id: 'a', order: 0 },
      { id: 'c', order: 5 },
      { id: 'd', order: 9 },
    ];
    expect(reindexSiblings(gapped)).toEqual([
      { id: 'a', order: 0 },
      { id: 'c', order: 1 },
      { id: 'd', order: 2 },
    ]);
  });

  it('returns an empty array for an empty set', () => {
    expect(reindexSiblings([])).toEqual([]);
  });
});

describe('collectCascade', () => {
  const chapters = [
    chap('c1', 'v1', 0),
    chap('c2', 'v1', 1),
    chap('c3', 'v2', 0),
  ];
  const scenes = [
    scene('s1', 'c1', 0),
    scene('s2', 'c1', 1),
    scene('s3', 'c2', 0),
    scene('s4', 'c3', 0),
  ];

  it('collects only itself when deleting a scene', () => {
    expect(collectCascade({ level: 'scene', id: 's3' }, { chapters, scenes })).toEqual({
      volumeIds: [],
      chapterIds: [],
      sceneIds: ['s3'],
    });
  });

  it('collects a chapter and all of its scenes', () => {
    expect(collectCascade({ level: 'chapter', id: 'c1' }, { chapters, scenes })).toEqual({
      volumeIds: [],
      chapterIds: ['c1'],
      sceneIds: ['s1', 's2'],
    });
  });

  it('collects a volume, all its chapters, and all those chapters\' scenes', () => {
    expect(collectCascade({ level: 'volume', id: 'v1' }, { chapters, scenes })).toEqual({
      volumeIds: ['v1'],
      chapterIds: ['c1', 'c2'],
      sceneIds: ['s1', 's2', 's3'],
    });
  });

  it('returns empty child sets for a volume with no chapters', () => {
    expect(collectCascade({ level: 'volume', id: 'vX' }, { chapters, scenes })).toEqual({
      volumeIds: ['vX'],
      chapterIds: [],
      sceneIds: [],
    });
  });
});

describe('buildOutlineTree', () => {
  it('groups chapters under volumes and scenes under chapters, each sorted by order', () => {
    const volumes = [vol('v2', 1), vol('v1', 0)];
    const chapters = [chap('c2', 'v1', 1), chap('c1', 'v1', 0), chap('c3', 'v2', 0)];
    const scenes = [scene('s2', 'c1', 1), scene('s1', 'c1', 0)];

    const tree = buildOutlineTree(volumes, chapters, scenes);

    expect(tree.map((n) => n.volume.id)).toEqual(['v1', 'v2']); // sorted by order
    expect(tree[0].chapters.map((c) => c.chapter.id)).toEqual(['c1', 'c2']); // sorted by order
    expect(tree[0].chapters[0].scenes.map((s) => s.scene.id)).toEqual(['s1', 's2']); // sorted by order
    expect(tree[1].chapters.map((c) => c.chapter.id)).toEqual(['c3']);
  });

  it('drops orphan chapters (missing volume) and orphan scenes (missing chapter)', () => {
    const volumes = [vol('v1', 0)];
    const chapters = [chap('c1', 'v1', 0), chap('cOrphan', 'vGhost', 1)];
    const scenes = [
      scene('s1', 'c1', 0),
      scene('sOrphan', 'cGhost', 0),     // 父章不存在
      scene('sUnderOrphan', 'cOrphan', 0), // 父章本身是孤儿 → 同样丢弃
    ];

    const tree = buildOutlineTree(volumes, chapters, scenes);

    expect(tree).toHaveLength(1);
    expect(tree[0].chapters.map((c) => c.chapter.id)).toEqual(['c1']);
    expect(tree[0].chapters[0].scenes.map((s) => s.scene.id)).toEqual(['s1']);
  });

  it('returns an empty array when there are no volumes', () => {
    expect(buildOutlineTree([], [], [])).toEqual([]);
  });
});
