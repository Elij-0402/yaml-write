/**
 * SkeletonTree 纯逻辑测试（Node 环境，无 RTL/jsdom）。
 * 验证导出接口、宽度常量契约、和条块渲染逻辑。
 */
import { describe, it, expect } from 'vitest';

// React 组件在 Node 环境无法渲染 JSX，但可以验证：
// 1. 模块导出形状
// 2. 直接调用组件函数，检查返回的 ReactElement 树（无需在测试作用域引入 React）

describe('SkeletonTree', () => {
  it('module exports a default function (component)', async () => {
    const mod = await import('../components/SkeletonTree');
    expect(typeof mod.default).toBe('function');
  });

  it('renders exactly 5 skeleton bars by default', async () => {
    const mod = await import('../components/SkeletonTree');
    const element = mod.default({});
    // ReactElement.props.children 是条块数组
    const children = element.props.children;
    expect(Array.isArray(children)).toBe(true);
    expect(children.length).toBe(5);
  });

  it('renders custom count when specified (e.g. 3)', async () => {
    const mod = await import('../components/SkeletonTree');
    const element = mod.default({ count: 3 });
    const children = element.props.children;
    expect(children.length).toBe(3);
  });

  it('caps at NODE_WIDTHS length even if count exceeds it', async () => {
    const mod = await import('../components/SkeletonTree');
    const element = mod.default({ count: 10 });
    const children = element.props.children;
    // NODE_WIDTHS 只有 5 项，slice(0, 10) 仍返回 5
    expect(children.length).toBe(5);
  });

  it('each bar has animate-pulse and motion-reduce:animate-none classes', async () => {
    const mod = await import('../components/SkeletonTree');
    const element = mod.default({});
    const children: Array<{ props: { className: string } }> = element.props.children;
    for (const bar of children) {
      expect(bar.props.className).toContain('animate-pulse');
      expect(bar.props.className).toContain('motion-reduce:animate-none');
    }
  });

  it('bars have progressively varying widths', async () => {
    const mod = await import('../components/SkeletonTree');
    const element = mod.default({});
    const children: Array<{ props: { className: string } }> = element.props.children;
    const widthClasses = children.map((bar) => {
      const match = bar.props.className.match(/w-\S+/);
      return match ? match[0] : '';
    });
    // 每个条块应有不同的 Tailwind 宽度类
    const uniqueWidths = new Set(widthClasses);
    expect(uniqueWidths.size).toBe(5);
  });

  it('outer wrapper includes border and rounded-sm classes (AC5)', async () => {
    const mod = await import('../components/SkeletonTree');
    const element = mod.default({});
    const wrapperClass: string = element.props.className;
    expect(wrapperClass).toContain('rounded-sm');
    expect(wrapperClass).toContain('border');
    expect(wrapperClass).toContain('border-line');
    expect(wrapperClass).toContain('bg-panel');
  });
});
