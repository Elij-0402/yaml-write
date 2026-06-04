import { describe, it, expect } from 'vitest';
import { isDnaReady, isExtracting, dnaPhase, canAutoStart, selectResumeTargets, planReconcile } from './dnaState';
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
