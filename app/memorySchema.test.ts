import { describe, it, expect } from 'vitest';
import {
  isEntityCardType,
  isEntityActiveState,
  ENTITY_CARD_TYPES,
  ENTITY_ACTIVE_STATES,
  DRAFT_HISTORY_MAX_PER_SCENE,
} from './memorySchema';

// 纯逻辑测试：只 import ./memorySchema（绝不 import ./db——它会 new NovelFusionDB() 触发 IndexedDB，node 下崩）。

describe('isEntityCardType', () => {
  it('accepts the 4 legal card types', () => {
    expect(isEntityCardType('worldview')).toBe(true);
    expect(isEntityCardType('character')).toBe(true);
    expect(isEntityCardType('prop')).toBe(true);
    expect(isEntityCardType('geography')).toBe(true);
  });
  it('rejects unknown strings and non-strings', () => {
    expect(isEntityCardType('hero')).toBe(false);
    expect(isEntityCardType('')).toBe(false);
    expect(isEntityCardType(null)).toBe(false);
    expect(isEntityCardType(undefined)).toBe(false);
    expect(isEntityCardType(123)).toBe(false);
  });
});

describe('isEntityActiveState', () => {
  it('accepts the 3 legal active states', () => {
    expect(isEntityActiveState('sceneActive')).toBe(true);
    expect(isEntityActiveState('globalActive')).toBe(true);
    expect(isEntityActiveState('idle')).toBe(true);
  });
  it('rejects unknown strings and non-strings', () => {
    expect(isEntityActiveState('active')).toBe(false);
    expect(isEntityActiveState('')).toBe(false);
    expect(isEntityActiveState(null)).toBe(false);
    expect(isEntityActiveState(undefined)).toBe(false);
    expect(isEntityActiveState(0)).toBe(false);
  });
});

describe('enum const arrays', () => {
  it('ENTITY_CARD_TYPES holds exactly the 4 expected members', () => {
    expect(ENTITY_CARD_TYPES).toHaveLength(4);
    expect([...ENTITY_CARD_TYPES]).toEqual(['worldview', 'character', 'prop', 'geography']);
  });
  it('ENTITY_ACTIVE_STATES holds exactly the 3 expected members', () => {
    expect(ENTITY_ACTIVE_STATES).toHaveLength(3);
    expect([...ENTITY_ACTIVE_STATES]).toEqual(['sceneActive', 'globalActive', 'idle']);
  });
  it('every const-array member is accepted by its guard', () => {
    for (const t of ENTITY_CARD_TYPES) expect(isEntityCardType(t)).toBe(true);
    for (const s of ENTITY_ACTIVE_STATES) expect(isEntityActiveState(s)).toBe(true);
  });
});

describe('DRAFT_HISTORY_MAX_PER_SCENE', () => {
  it('pins the FR-EDT-003 per-scene snapshot cap at 10', () => {
    expect(DRAFT_HISTORY_MAX_PER_SCENE).toBe(10);
  });
});
