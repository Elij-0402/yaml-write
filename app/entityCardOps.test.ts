import { describe, it, expect } from 'vitest';
import { nextOrder, reindexCards, groupCardsByType } from './entityCardOps';
import type { EntityCard, EntityCardType } from './memorySchema';

// —— 测试工厂：只填影响逻辑的字段（id / type / order），其余给确定缺省
//    （本模块纯逻辑只读 id / type / order；name 用 id 便于断言可读）——
const card = (id: string, type: EntityCardType, order: number, novelId = 'n1'): EntityCard => ({
  id,
  novelId,
  type,
  name: id,
  summary: '',
  details: '',
  activeState: 'idle',
  order,
  createdAt: 0,
  updatedAt: 0,
});

describe('nextOrder', () => {
  it('returns the start value (0) for an empty group', () => {
    expect(nextOrder([])).toBe(0);
  });

  it('returns max(order) + 1 for a non-empty group (gaps & unsorted tolerated)', () => {
    expect(nextOrder([{ order: 0 }, { order: 1 }, { order: 2 }])).toBe(3);
    expect(nextOrder([{ order: 5 }, { order: 2 }])).toBe(6); // 乱序 → 仍取 max+1
    expect(nextOrder([{ order: 0 }])).toBe(1);
    expect(nextOrder([{ order: 0 }, { order: 3 }])).toBe(4); // 空洞容忍 → max+1，非 length
  });
});

describe('reindexCards', () => {
  it('compacts gappy orders into a contiguous 0..n-1 sequence (sorted by order)', () => {
    const gapped = [
      { id: 'a', order: 0 },
      { id: 'c', order: 5 },
      { id: 'd', order: 9 },
    ];
    expect(reindexCards(gapped)).toEqual([
      { id: 'a', order: 0 },
      { id: 'c', order: 1 },
      { id: 'd', order: 2 },
    ]);
  });

  it('returns an empty array for an empty group', () => {
    expect(reindexCards([])).toEqual([]);
  });

  it('compacts by current order, not input order (unsorted input)', () => {
    const unsorted = [
      { id: 'c', order: 2 },
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ];
    expect(reindexCards(unsorted)).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
      { id: 'c', order: 2 },
    ]);
  });
});

describe('groupCardsByType', () => {
  it('always returns the four types in ENTITY_CARD_TYPES order, empty groups included', () => {
    const groups = groupCardsByType([]);
    expect(groups.map((g) => g.type)).toEqual(['worldview', 'character', 'prop', 'geography']);
    expect(groups.every((g) => g.cards.length === 0)).toBe(true);
    expect(groups).toHaveLength(4);
  });

  it('buckets each card under its type and sorts every group by order ascending', () => {
    const cards = [
      card('w2', 'worldview', 1),
      card('w1', 'worldview', 0),
      card('p1', 'prop', 0),
      card('c1', 'character', 3),
    ];
    const byType = Object.fromEntries(
      groupCardsByType(cards).map((g) => [g.type, g.cards.map((c) => c.id)]),
    );
    expect(byType.worldview).toEqual(['w1', 'w2']); // 组内按 order 升序
    expect(byType.character).toEqual(['c1']);
    expect(byType.prop).toEqual(['p1']);
    expect(byType.geography).toEqual([]); // 空组保持空
  });

  it('breaks ties on equal order deterministically by input order', () => {
    const cards = [
      card('first', 'character', 0),
      card('second', 'character', 0),
      card('third', 'character', 0),
    ];
    const chars = groupCardsByType(cards).find((g) => g.type === 'character')!;
    expect(chars.cards.map((c) => c.id)).toEqual(['first', 'second', 'third']);
  });

  it('keeps the four groups isolated (a card never leaks into another type)', () => {
    const cards = [card('g1', 'geography', 0), card('g2', 'geography', 1)];
    const groups = groupCardsByType(cards);
    const geo = groups.find((g) => g.type === 'geography')!;
    expect(geo.cards.map((c) => c.id)).toEqual(['g1', 'g2']);
    expect(groups.filter((g) => g.type !== 'geography').every((g) => g.cards.length === 0)).toBe(true);
  });
});
