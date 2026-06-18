/**
 * ApiKeyNoticeCard 纯逻辑测试（Node 环境，无 RTL/jsdom）。
 * 直接调用组件函数，检查返回的 ReactElement 树结构（无需在测试作用域引入 React）。
 */
import { describe, it, expect, vi } from 'vitest';

describe('ApiKeyNoticeCard', () => {
  it('module exports a default function (component)', async () => {
    const mod = await import('./ApiKeyNoticeCard');
    expect(typeof mod.default).toBe('function');
  });

  it('renders with role="status" for accessibility', async () => {
    const mod = await import('./ApiKeyNoticeCard');
    const element = mod.default({ onConfigure: () => {} });
    expect(element.props.role).toBe('status');
  });

  it('wrapper includes spec-required border-accent/30 and bg-accent/5 classes (AC5)', async () => {
    const mod = await import('./ApiKeyNoticeCard');
    const element = mod.default({ onConfigure: () => {} });
    const className: string = element.props.className;
    expect(className).toContain('border-accent/30');
    expect(className).toContain('bg-accent/5');
    expect(className).toContain('rounded-sm');
  });

  it('contains a button element with btn-primary class', async () => {
    const mod = await import('./ApiKeyNoticeCard');
    const element = mod.default({ onConfigure: () => {} });
    // ReactElement 的 children 结构：[KeyRound icon, div (text), button]
    const children = element.props.children;
    const button = children.find(
      (child: { type?: string; props?: { className?: string } }) =>
        child?.type === 'button'
    );
    expect(button).toBeTruthy();
    expect(button.props.className).toContain('btn-primary');
  });

  it('calls onConfigure callback when button is clicked', async () => {
    const spy = vi.fn();
    const mod = await import('./ApiKeyNoticeCard');
    const element = mod.default({ onConfigure: spy });
    const children = element.props.children;
    const button = children.find(
      (child: { type?: string }) => child?.type === 'button'
    );
    // 直接调用 onClick handler
    button.props.onClick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('renders notification text about missing API key', async () => {
    const mod = await import('./ApiKeyNoticeCard');
    const element = mod.default({ onConfigure: () => {} });
    const children = element.props.children;
    // 文案在第二个子元素（div）中
    const textDiv = children.find(
      (child: { type?: string; props?: { className?: string } }) =>
        child?.type === 'div' && child?.props?.className?.includes('text-fg-muted')
    );
    expect(textDiv).toBeTruthy();
    expect(textDiv.props.children).toContain('未检测到 API 密钥');
  });
});
