import { describe, it, expect } from 'vitest';
import { isDnaReady, isExtracting, dnaPhase, canAutoStart, selectResumeTargets, planReconcile, initDraftLoop, advanceLoop, shouldRetry, lastFeedback, isFused } from './dnaState';
import type { DraftLoopState } from './dnaState';
import type { SceneEvaluateResponse } from './dnaSchema';
import type { AnalysisStatus, MapStatus } from './db';

// 最小「提取状态」夹具：只含被读取的两个字段。truthy 卡用占位对象——判定式只看 presence，不看卡内部形状。
const CARD = { placeholder: true };
const state = (analysisStatus: AnalysisStatus, dnaCard: unknown = null) => ({ analysisStatus, dnaCard });

describe('isDnaReady', () => {
  it('is true only when analysisStatus is done AND a dnaCard exists', () => {
    expect(isDnaReady(state('done', CARD))).toBe(true);
  });

  it('is false when done but the dnaCard is missing', () => {
    expect(isDnaReady(state('done'))).toBe(false);
  });

  it('is false for every non-done status (idle / mapping / reducing / error)', () => {
    expect(isDnaReady(state('idle', CARD))).toBe(false);
    expect(isDnaReady(state('mapping'))).toBe(false);
    expect(isDnaReady(state('reducing'))).toBe(false);
    expect(isDnaReady(state('error'))).toBe(false);
  });

  it('is false for a missing novel', () => {
    expect(isDnaReady(null)).toBe(false);
    expect(isDnaReady(undefined)).toBe(false);
  });
});

describe('isExtracting', () => {
  it('is true while mapping', () => {
    expect(isExtracting(state('mapping'))).toBe(true);
  });

  it('is true while reducing', () => {
    expect(isExtracting(state('reducing'))).toBe(true);
  });

  it('is false for idle / done / error and a missing novel', () => {
    expect(isExtracting(state('idle'))).toBe(false);
    expect(isExtracting(state('done', CARD))).toBe(false);
    expect(isExtracting(state('error'))).toBe(false);
    expect(isExtracting(null)).toBe(false);
  });
});

describe('dnaPhase', () => {
  it('projects idle (no card) to "idle"', () => {
    expect(dnaPhase(state('idle'))).toBe('idle');
  });

  it('collapses both mapping and reducing to "extracting"', () => {
    expect(dnaPhase(state('mapping'))).toBe('extracting');
    expect(dnaPhase(state('reducing'))).toBe('extracting');
  });

  it('projects done-with-card to "ready"', () => {
    expect(dnaPhase(state('done', CARD))).toBe('ready');
  });

  it('projects error to "error"', () => {
    expect(dnaPhase(state('error'))).toBe('error');
  });

  it('falls back to "idle" for a missing novel', () => {
    expect(dnaPhase(null)).toBe('idle');
    expect(dnaPhase(undefined)).toBe('idle');
  });
});

describe('canAutoStart', () => {
  it('is true only for a fresh idle book with no dnaCard', () => {
    expect(canAutoStart(state('idle'))).toBe(true);
  });

  it('is false for an idle book that already has a dnaCard (re-extract is manual)', () => {
    expect(canAutoStart(state('idle', CARD))).toBe(false);
  });

  it('never auto-starts an in-flight, finished, or failed book', () => {
    expect(canAutoStart(state('mapping'))).toBe(false);
    expect(canAutoStart(state('reducing'))).toBe(false);
    expect(canAutoStart(state('done', CARD))).toBe(false);
    expect(canAutoStart(state('error'))).toBe(false);
  });

  it('is false for a missing novel', () => {
    expect(canAutoStart(null)).toBe(false);
    expect(canAutoStart(undefined)).toBe(false);
  });
});

describe('selectResumeTargets', () => {
  // 弧窗只用 lead 章（id）做续跑判定；构造最小 unit + 一张 lead→mapStatus 查表。
  const unit = (id: string) => ({ id, chapterIds: [id], label: id });
  const byId = (entries: Record<string, MapStatus>) =>
    new Map(Object.entries(entries).map(([id, mapStatus]) => [id, { mapStatus }]));

  it('keeps only units whose lead chapter is not done (skips done leads)', () => {
    const units = [unit('a'), unit('b'), unit('c')];
    const targets = selectResumeTargets(units, byId({ a: 'done', b: 'pending', c: 'mapping' }));
    expect(targets.map((u) => u.id)).toEqual(['b', 'c']);
  });

  it('returns an empty list when every lead is already done', () => {
    const units = [unit('a'), unit('b')];
    expect(selectResumeTargets(units, byId({ a: 'done', b: 'done' }))).toEqual([]);
  });

  it('returns every unit unchanged when no lead is done', () => {
    const units = [unit('a'), unit('b')];
    expect(selectResumeTargets(units, byId({ a: 'pending', b: 'error' }))).toEqual(units);
  });

  it('treats a lead missing from the lookup as not-done (a target)', () => {
    const units = [unit('a')];
    expect(selectResumeTargets(units, byId({}))).toEqual(units);
  });
});

describe('planReconcile', () => {
  // 章节快照夹具：只含被读取的两个字段。
  const ch = (id: string, mapStatus: MapStatus) => ({ id, mapStatus });
  // 混合章节：两个滞留 mapping、一个 done、一个 pending。
  const mixed = [ch('m1', 'mapping'), ch('d1', 'done'), ch('m2', 'mapping'), ch('p1', 'pending')];

  it('reconciles a book stranded in mapping: status → idle, reset exactly the mapping chapters', () => {
    const plan = planReconcile(state('mapping'), mixed);
    expect(plan).toEqual({ nextAnalysisStatus: 'idle', resetChapterIds: ['m1', 'm2'] });
  });

  it('reconciles a book stranded in reducing (no mapping chapters left → empty reset list)', () => {
    const plan = planReconcile(state('reducing'), [ch('d1', 'done'), ch('d2', 'done')]);
    expect(plan).toEqual({ nextAnalysisStatus: 'idle', resetChapterIds: [] });
  });

  it('leaves done chapters untouched so resume skips them', () => {
    const plan = planReconcile(state('mapping'), mixed);
    expect(plan?.resetChapterIds).not.toContain('d1');
  });

  it('returns null for a clean done book (nothing to heal)', () => {
    expect(planReconcile(state('done', CARD), mixed)).toBeNull();
  });

  it('returns null for an idle book', () => {
    expect(planReconcile(state('idle'), mixed)).toBeNull();
  });

  it('returns null for a failed (error) book — failures stay visible, not silently reset', () => {
    expect(planReconcile(state('error'), mixed)).toBeNull();
  });
});

// ---- DraftLoop 闭环状态机测试 ----
// 测试夹具：构造最小 SceneEvaluateResponse（仅读 passed / actionableFeedback / failedGates）。

const report = (passed: boolean, feedback = '', failedGates: string[] = []): SceneEvaluateResponse => ({
  sceneId: 'test-scene',
  attempt: 0,
  passed,
  failedGates,
  evidence: 'test evidence',
  actionableFeedback: feedback,
});

describe('DraftLoop state machine', () => {
  describe('initDraftLoop', () => {
    it('returns correct initial state', () => {
      const state = initDraftLoop();
      expect(state).toEqual({ phase: 'idle', attempt: 0, maxAttempts: 2, reports: [] });
    });

    it('supports custom maxAttempts configuration', () => {
      const state = initDraftLoop(5);
      expect(state.maxAttempts).toBe(5);
    });
  });

  describe('advanceLoop', () => {
    it('transitions to passed when report.passed is true', () => {
      const s: DraftLoopState = { ...initDraftLoop(), phase: 'auditing' };
      const next = advanceLoop(s, report(true));
      expect(next.phase).toBe('passed');
      expect(next.reports).toHaveLength(1);
      expect(next.reports[0].passed).toBe(true);
    });

    it('transitions to streaming (retry 1) when passed:false and attempt < maxAttempts', () => {
      const s: DraftLoopState = { ...initDraftLoop(), phase: 'auditing', attempt: 0 };
      const next = advanceLoop(s, report(false, '第一次反馈'));
      expect(next.phase).toBe('streaming');
      expect(next.attempt).toBe(1);
      expect(next.reports).toHaveLength(1);
    });

    it('transitions to streaming (retry 2) when passed:false and attempt = 1 < maxAttempts', () => {
      const s: DraftLoopState = { ...initDraftLoop(), phase: 'auditing', attempt: 1 };
      const next = advanceLoop(s, report(false, '第二次反馈'));
      expect(next.phase).toBe('streaming');
      expect(next.attempt).toBe(2);
      expect(next.reports).toHaveLength(1);
    });

    it('transitions to fused when passed:false and attempt >= maxAttempts', () => {
      const s: DraftLoopState = { ...initDraftLoop(), phase: 'auditing', attempt: 2 };
      const next = advanceLoop(s, report(false, '第三次反馈', ['styleLock']));
      expect(next.phase).toBe('fused');
      expect(next.attempt).toBe(3);
      expect(next.reports).toHaveLength(1);
    });

    it('guards against advanceLoop calls when already in a terminal state (passed or fused)', () => {
      const passedState: DraftLoopState = { phase: 'passed', attempt: 0, maxAttempts: 2, reports: [report(true)] };
      const afterPassed = advanceLoop(passedState, report(false, '不应发生的调用'));
      expect(afterPassed).toEqual(passedState);

      const fusedState: DraftLoopState = { phase: 'fused', attempt: 2, maxAttempts: 2, reports: [report(false), report(false)] };
      const afterFused = advanceLoop(fusedState, report(true));
      expect(afterFused).toEqual(fusedState);
    });

    it('accumulates reports across multiple advances', () => {
      let s: DraftLoopState = { ...initDraftLoop(), phase: 'auditing' };
      s = advanceLoop(s, report(false, '第一次反馈'));
      expect(s.reports).toHaveLength(1);
      s = { ...s, phase: 'auditing' };
      s = advanceLoop(s, report(false, '第二次反馈'));
      expect(s.reports).toHaveLength(2);
      s = { ...s, phase: 'auditing' };
      s = advanceLoop(s, report(false, '第三次反馈'));
      expect(s.reports).toHaveLength(3);
      expect(s.phase).toBe('fused');
    });

    it('passes on first attempt without incrementing', () => {
      const s: DraftLoopState = { ...initDraftLoop(), phase: 'auditing' };
      const next = advanceLoop(s, report(true));
      expect(next.attempt).toBe(0);
      expect(next.phase).toBe('passed');
    });
  });

  describe('shouldRetry', () => {
    it('is true when phase is streaming and attempt > 0', () => {
      expect(shouldRetry({ ...initDraftLoop(), phase: 'streaming', attempt: 1 })).toBe(true);
      expect(shouldRetry({ ...initDraftLoop(), phase: 'streaming', attempt: 2 })).toBe(true);
    });

    it('is false when phase is streaming but attempt is 0 (first generation, not a retry)', () => {
      expect(shouldRetry({ ...initDraftLoop(), phase: 'streaming', attempt: 0 })).toBe(false);
    });

    it('is false for non-streaming phases', () => {
      expect(shouldRetry({ ...initDraftLoop(), phase: 'idle' })).toBe(false);
      expect(shouldRetry({ ...initDraftLoop(), phase: 'auditing', attempt: 1 })).toBe(false);
      expect(shouldRetry({ ...initDraftLoop(), phase: 'passed', attempt: 1 })).toBe(false);
      expect(shouldRetry({ ...initDraftLoop(), phase: 'fused', attempt: 2 })).toBe(false);
    });
  });

  describe('isFused', () => {
    it('is true only when phase is fused', () => {
      expect(isFused({ ...initDraftLoop(), phase: 'fused' })).toBe(true);
    });

    it('is false for all other phases', () => {
      expect(isFused({ ...initDraftLoop(), phase: 'idle' })).toBe(false);
      expect(isFused({ ...initDraftLoop(), phase: 'streaming' })).toBe(false);
      expect(isFused({ ...initDraftLoop(), phase: 'auditing' })).toBe(false);
      expect(isFused({ ...initDraftLoop(), phase: 'passed' })).toBe(false);
    });
  });

  describe('lastFeedback', () => {
    it('returns empty string when no reports exist', () => {
      expect(lastFeedback(initDraftLoop())).toBe('');
    });

    it('returns the actionableFeedback from the last report', () => {
      const r1 = report(false, '第一次反馈');
      const r2 = report(false, '第二次反馈');
      const s = { ...initDraftLoop(), reports: [r1, r2] };
      expect(lastFeedback(s)).toBe('第二次反馈');
    });

    it('returns the only report feedback when there is exactly one', () => {
      const r = report(false, '唯一反馈');
      const s = { ...initDraftLoop(), reports: [r] };
      expect(lastFeedback(s)).toBe('唯一反馈');
    });
  });
});
