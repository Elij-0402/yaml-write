// 网络离线降级的纯判定层（镜像 coldStartState.ts / layoutPrefs.ts 的「纯规划层」范式）。
// 不得 import react / zustand / ./store / DOM 实例，以保 node 环境纯逻辑单测（见 networkStatus.test.ts）。
// 可判定逻辑全部下沉于此：SSR 安全初值、LLM 闸门、连通态派生与离线文案常量（单一事实源）。

/** SSR/预渲染安全：navigator 缺失时默认「在线」，避免首屏误闪离线；挂载后由事件 / 求真覆盖。 */
export function getInitialOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/**
 * LLM 可用闸门：密钥就绪「且」在线。
 * Epic 3 的发送 / 起草按钮 disabled={!canUseLlm(...)} 可直接复用本函数。
 */
export function canUseLlm(llmReady: boolean, isOffline: boolean): boolean {
  return llmReady && !isOffline;
}

/** 连通态派生：供底部状态栏渲染标签与色调（离线 = 红 danger；在线 = 中性灰）。 */
export function deriveConnectivity(isOffline: boolean): { label: string; tone: 'offline' | 'online' } {
  return isOffline ? { label: '离线模式', tone: 'offline' } : { label: '在线', tone: 'online' };
}

// 离线文案常量（单一事实源）：StatusBar / 离线 Toast / 右 pane 提示统一引用，杜绝魔法串散落与文案漂移。
export const OFFLINE_TOAST_TEXT = '当前处于离线状态，大模型生成不可用。本地写作已安全保存。';
export const OFFLINE_DISABLED_HINT = '离线模式下大模型不可用';
