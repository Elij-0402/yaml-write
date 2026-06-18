import { describe, it, expect } from 'vitest';
import { getColdStartState } from './coldStartState';

describe('getColdStartState', () => {
  it('returns loading state when novelCount is undefined (useLiveQuery pending)', () => {
    const result = getColdStartState(undefined);
    expect(result).toEqual({ showSkeleton: false, showEmptyPlaceholder: false, isLoading: true });
  });

  it('returns skeleton state when novelCount is 0 (empty IndexedDB)', () => {
    const result = getColdStartState(0);
    expect(result).toEqual({ showSkeleton: true, showEmptyPlaceholder: false, isLoading: false });
  });

  it('returns placeholder state when novelCount is 1', () => {
    const result = getColdStartState(1);
    expect(result).toEqual({ showSkeleton: false, showEmptyPlaceholder: true, isLoading: false });
  });

  it('returns placeholder state for large novelCount', () => {
    const result = getColdStartState(100);
    expect(result).toEqual({ showSkeleton: false, showEmptyPlaceholder: true, isLoading: false });
  });

  it('treats negative novelCount as 0 (defensive guard)', () => {
    const result = getColdStartState(-1);
    expect(result).toEqual({ showSkeleton: true, showEmptyPlaceholder: false, isLoading: false });
  });

  it('treats -Infinity as 0 (defensive guard)', () => {
    const result = getColdStartState(-Infinity);
    expect(result).toEqual({ showSkeleton: true, showEmptyPlaceholder: false, isLoading: false });
  });

  // 互斥性：三个布尔标志中永远恰好只有一个为 true
  it.each([
    ['undefined', undefined],
    ['0', 0],
    ['1', 1],
    ['100', 100],
    ['-1', -1],
  ] as const)('exactly one flag is true for novelCount = %s', (_label, count) => {
    const result = getColdStartState(count as number | undefined);
    const trueCount = [result.showSkeleton, result.showEmptyPlaceholder, result.isLoading].filter(Boolean).length;
    expect(trueCount).toBe(1);
  });
});