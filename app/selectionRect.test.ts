import { describe, it, expect } from 'vitest';
import {
  spliceRange,
  isRangeIntact,
  placeTrigger,
  selectionRectToContainer,
} from './selectionRect';

// Story 4.2 划词改写的纯逻辑单测（node 环境，无 DOM）。覆盖：
//  · spliceRange —— 按索引区间替换（AC3 杜绝同句首次匹配误伤）；
//  · isRangeIntact —— 接受前的区间一致性校验（漂移则回退）；
//  · placeTrigger —— 浮动触角上/下方位翻转 + 水平钳制；
//  · selectionRectToContainer —— 镜像量算视口矩形 → 容器相对坐标换算。

describe('spliceRange（按索引区间替换 · AC3）', () => {
  it('替换指定区间的子串', () => {
    expect(spliceRange('hello world', 6, 11, 'there')).toBe('hello there');
  });

  it('正文出现两处相同片段时，只替换索引命中的那一处（不是首次匹配）', () => {
    // 「她笑了。她笑了。」——索引：她0 笑1 了2 。3 她4 笑5 了6 。7
    const text = '她笑了。她笑了。';
    // 划选并接受第二处 [4,8] → 仅第二处变「她哭了。」，第一处原样
    expect(spliceRange(text, 4, 8, '她哭了。')).toBe('她笑了。她哭了。');
    // 对照：第一处 [0,4]
    expect(spliceRange(text, 0, 4, '她哭了。')).toBe('她哭了。她笑了。');
  });

  it('空区间（start===end）等价于在该位置插入', () => {
    expect(spliceRange('abc', 1, 1, 'X')).toBe('aXbc');
  });

  it('越界索引被钳制到 [0, len]', () => {
    expect(spliceRange('abc', -5, 99, 'Z')).toBe('Z');
  });

  it('start > end 时自动交换，按区间替换不抛错', () => {
    expect(spliceRange('abcdef', 4, 2, 'X')).toBe('abXef');
  });
});

describe('isRangeIntact（接受前区间一致性校验）', () => {
  it('索引区间文本与期望一致时为 true', () => {
    expect(isRangeIntact('hello there', 6, 11, 'there')).toBe(true);
  });

  it('文本漂移导致区间内容不再等于期望时为 false', () => {
    expect(isRangeIntact('hi hello there', 6, 11, 'there')).toBe(false);
  });
});

describe('placeTrigger（浮动触角方位 + 钳制）', () => {
  const base = { anchorHeight: 24, triggerWidth: 120, triggerHeight: 30, containerWidth: 600, gap: 8 };

  it('上方空间充足 → 置于选区上方', () => {
    const r = placeTrigger({ ...base, anchorTop: 100, anchorLeft: 200 });
    expect(r.placement).toBe('above');
    expect(r.top).toBe(100 - 30 - 8); // 62
    expect(r.left).toBe(200);
  });

  it('上方空间不足（放不下触角+间隙）→ 翻到选区下方', () => {
    const r = placeTrigger({ ...base, anchorTop: 10, anchorLeft: 200 });
    expect(r.placement).toBe('below');
    expect(r.top).toBe(10 + 24 + 8); // 42
  });

  it('水平超出右边界时钳制到 containerWidth - triggerWidth', () => {
    const r = placeTrigger({ ...base, anchorTop: 100, anchorLeft: 560 });
    expect(r.left).toBe(600 - 120); // 480
  });

  it('水平为负时钳制到 0', () => {
    const r = placeTrigger({ ...base, anchorTop: 100, anchorLeft: -20 });
    expect(r.left).toBe(0);
  });
});

describe('selectionRectToContainer（镜像视口矩形 → 容器相对坐标）', () => {
  it('扣除镜像原点与滚动、叠加 textarea 屏幕位、再减容器原点', () => {
    // 镜像离屏放在 -9000；选区片段在镜像内偏移 50px（rectTop = -9000 + 50）。
    const rect = selectionRectToContainer({
      rectTop: -8950, rectLeft: -8940, rectWidth: 120, rectHeight: 29,
      mirrorTop: -9000, mirrorLeft: -9000,
      textareaScreenTop: 200, textareaScreenLeft: 80,
      scrollTop: 20, scrollLeft: 0,
      containerScreenTop: 180, containerScreenLeft: 60,
    });
    // screenTop = 200 + (−8950 − −9000) − 20 = 230 ; top = 230 − 180 = 50
    expect(rect.top).toBe(50);
    // screenLeft = 80 + (−8940 − −9000) − 0 = 140 ; left = 140 − 60 = 80
    expect(rect.left).toBe(80);
    expect(rect.height).toBe(29);
    expect(rect.width).toBe(120);
    expect(rect.bottom).toBe(50 + 29);
  });
});
