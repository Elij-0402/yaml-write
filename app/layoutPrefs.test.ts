import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LAYOUT,
  clampSidebarWidth,
  clampMainSplitPct,
  normalizeLayout,
} from './layoutPrefs';

describe('DEFAULT_LAYOUT', () => {
  it('matches AC1 冷启动默认：侧栏 240px、未折叠、左 pane 55%', () => {
    expect(DEFAULT_LAYOUT).toEqual({ sidebarWidth: 240, sidebarCollapsed: false, mainSplitPct: 55 });
  });
});

describe('clampSidebarWidth — 侧栏宽夹在 160–400（取整 px）', () => {
  it('保留区间内的宽度（四舍五入到整数 px）', () => {
    expect(clampSidebarWidth(240)).toBe(240);
    expect(clampSidebarWidth(200.4)).toBe(200);
    expect(clampSidebarWidth(160)).toBe(160);
    expect(clampSidebarWidth(400)).toBe(400);
  });
  it('低于 160 / 高于 400 一律夹回边界', () => {
    expect(clampSidebarWidth(120)).toBe(160);
    expect(clampSidebarWidth(0)).toBe(160);
    expect(clampSidebarWidth(-50)).toBe(160);
    expect(clampSidebarWidth(99999)).toBe(400);
  });
  it('非有限值回落到默认宽度（脏持久化数据兜底）', () => {
    expect(clampSidebarWidth(NaN)).toBe(DEFAULT_LAYOUT.sidebarWidth);
    expect(clampSidebarWidth(Infinity)).toBe(DEFAULT_LAYOUT.sidebarWidth);
  });
});

describe('clampMainSplitPct — 静态（无容器宽，仅右 pane 25–60% 约束）', () => {
  it('默认 55 原样保留', () => {
    expect(clampMainSplitPct(55)).toBe(55);
  });
  it('左 pane 上限 75（右 ≥25%）、下限 40（右 ≤60%）', () => {
    expect(clampMainSplitPct(90)).toBe(75);
    expect(clampMainSplitPct(10)).toBe(40);
  });
  it('非有限值回落到默认占比', () => {
    expect(clampMainSplitPct(NaN)).toBe(DEFAULT_LAYOUT.mainSplitPct);
  });
});

describe('clampMainSplitPct — 容器宽感知（右 pane 必须 ≥300px）', () => {
  it('宽容器下舒适占比原样保留（右 450px / 45%，两条约束都满足）', () => {
    expect(clampMainSplitPct(55, 1000)).toBe(55);
  });
  it('容器变窄时下压左 pane，使右 pane 守住 ≥300px', () => {
    // 右 45% 在 600px 容器 = 270px < 300 → 右下限抬到 300/600 = 50% → 左 50
    expect(clampMainSplitPct(55, 600)).toBe(50);
    // 300/500 = 60% 下限 → 左 40
    expect(clampMainSplitPct(55, 500)).toBe(40);
  });
  it('极窄容器下 300px 硬地板压过 60% 上限（取更严者）', () => {
    // 300/400 = 75% 下限 > 60% 上限 → 地板赢 → 左 25
    expect(clampMainSplitPct(55, 400)).toBe(25);
  });
  it('宽容器下右 pane 仍被 60% 上限封顶', () => {
    // 左 10 → 右 90 → 封到 60% → 左 40
    expect(clampMainSplitPct(10, 1000)).toBe(40);
  });
});

describe('normalizeLayout — 脏数据 / 越界值纠正（迁移与容错）', () => {
  it('null / undefined / 非对象 → 默认布局副本', () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout(42)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout('nope')).toEqual(DEFAULT_LAYOUT);
  });
  it('返回的是默认副本而非共享引用（防意外突变）', () => {
    const a = normalizeLayout(null);
    expect(a).not.toBe(DEFAULT_LAYOUT);
  });
  it('缺失字段用默认补齐', () => {
    expect(normalizeLayout({})).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout({ sidebarWidth: 320 })).toEqual({
      sidebarWidth: 320,
      sidebarCollapsed: false,
      mainSplitPct: 55,
    });
  });
  it('越界 / 类型错误的字段被夹取与纠正', () => {
    expect(normalizeLayout({ sidebarWidth: 9999, sidebarCollapsed: 'yes', mainSplitPct: 999 })).toEqual({
      sidebarWidth: 400,
      sidebarCollapsed: false,
      mainSplitPct: 75,
    });
    expect(normalizeLayout({ sidebarWidth: 10, mainSplitPct: 5 })).toEqual({
      sidebarWidth: 160,
      sidebarCollapsed: false,
      mainSplitPct: 40,
    });
  });
  it('保留合法的折叠态', () => {
    expect(normalizeLayout({ sidebarWidth: 240, sidebarCollapsed: true, mainSplitPct: 55 })).toEqual({
      sidebarWidth: 240,
      sidebarCollapsed: true,
      mainSplitPct: 55,
    });
  });
});
