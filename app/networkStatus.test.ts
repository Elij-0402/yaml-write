import { describe, it, expect, afterEach } from 'vitest';
import {
  getInitialOnline,
  canUseLlm,
  deriveConnectivity,
  OFFLINE_TOAST_TEXT,
  OFFLINE_DISABLED_HINT,
} from './networkStatus';

// node 环境下 navigator 可能是只读 getter（Node 21+）。保存原始描述符、每用例后还原，
// 既能模拟「navigator 缺失（SSR）」也能注入不同 onLine 值，且不污染其它测试。
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function restoreNavigator(): void {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
}

describe('getInitialOnline', () => {
  afterEach(restoreNavigator);

  it('returns true when navigator is undefined (SSR / prerender safe — default online)', () => {
    setNavigator(undefined);
    expect(getInitialOnline()).toBe(true);
  });

  it('reflects navigator.onLine === true', () => {
    setNavigator({ onLine: true });
    expect(getInitialOnline()).toBe(true);
  });

  it('reflects navigator.onLine === false', () => {
    setNavigator({ onLine: false });
    expect(getInitialOnline()).toBe(false);
  });
});

describe('canUseLlm', () => {
  // 四种组合全覆盖：密钥就绪且在线时才放行；缺密钥或离线任一成立即闸断。
  it.each([
    [true, false, true],
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ] as const)('canUseLlm(llmReady=%s, isOffline=%s) === %s', (llmReady, isOffline, expected) => {
    expect(canUseLlm(llmReady, isOffline)).toBe(expected);
  });
});

describe('deriveConnectivity', () => {
  it('offline → { label: 离线模式, tone: offline }', () => {
    expect(deriveConnectivity(true)).toEqual({ label: '离线模式', tone: 'offline' });
  });

  it('online → { label: 在线, tone: online }', () => {
    expect(deriveConnectivity(false)).toEqual({ label: '在线', tone: 'online' });
  });
});

describe('copy constants (single source of truth — guard against drift)', () => {
  it('OFFLINE_TOAST_TEXT is the exact offline toast copy', () => {
    expect(OFFLINE_TOAST_TEXT).toBe('当前处于离线状态，大模型生成不可用。本地写作已安全保存。');
  });

  it('OFFLINE_DISABLED_HINT is the exact right-pane hint copy', () => {
    expect(OFFLINE_DISABLED_HINT).toBe('离线模式下大模型不可用');
  });
});
