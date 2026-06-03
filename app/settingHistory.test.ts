import { describe, it, expect } from 'vitest';
import { appendSnapshot, popSnapshot, MAX_SETTING_HISTORY } from './settingHistory';

const blocks = (w: string) => ({ worldviewBlock: w, protagonistBlock: '', antagonistBlock: '', narrativeTone: '' });

describe('appendSnapshot', () => {
  it('appends a snapshot to an empty/undefined history', () => {
    const h = appendSnapshot(undefined, blocks('v1'), '初始', 1);
    expect(h).toHaveLength(1);
    expect(h[0].blocks.worldviewBlock).toBe('v1');
    expect(h[0].note).toBe('初始');
    expect(h[0].at).toBe(1);
  });

  it('copies blocks so later mutation of the source does not leak in', () => {
    const src = blocks('v1');
    const h = appendSnapshot([], src, 'n', 1);
    src.worldviewBlock = 'mutated';
    expect(h[0].blocks.worldviewBlock).toBe('v1');
  });

  it('caps history to the most recent MAX entries', () => {
    let h: ReturnType<typeof appendSnapshot> = [];
    for (let i = 0; i < MAX_SETTING_HISTORY + 5; i += 1) {
      h = appendSnapshot(h, blocks(`v${i}`), 'n', i);
    }
    expect(h).toHaveLength(MAX_SETTING_HISTORY);
    expect(h[h.length - 1].blocks.worldviewBlock).toBe(`v${MAX_SETTING_HISTORY + 4}`); // 最新保留
    expect(h[0].blocks.worldviewBlock).toBe('v5'); // 最旧被裁掉
  });
});

describe('popSnapshot', () => {
  it('returns null for empty history', () => {
    expect(popSnapshot([])).toEqual({ restored: null, history: [] });
    expect(popSnapshot(undefined)).toEqual({ restored: null, history: [] });
  });

  it('pops the most recent snapshot and shortens the history', () => {
    const h = appendSnapshot(appendSnapshot([], blocks('a'), 'n', 1), blocks('b'), 'n', 2);
    const { restored, history } = popSnapshot(h);
    expect(restored?.blocks.worldviewBlock).toBe('b');
    expect(history).toHaveLength(1);
    expect(history[0].blocks.worldviewBlock).toBe('a');
  });
});
