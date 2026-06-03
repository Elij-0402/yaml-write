// 设定版本历史的纯逻辑（无 Dexie 运行时依赖；type-only 引用 SettingSnapshot）。
// 接受 AI 改动「前」对四块设定拍快照入栈，支持一键回退（试错零成本）。在 settingHistory.test.ts 单测。
import type { SettingSnapshot } from './db';

export const MAX_SETTING_HISTORY = 30;

export type SettingBlocks = SettingSnapshot['blocks'];

// 追加一条快照并按上限裁尾（保留最近 MAX 条）。返回新数组（不可变）。
export function appendSnapshot(
  history: SettingSnapshot[] | undefined,
  blocks: SettingBlocks,
  note: string,
  at: number,
): SettingSnapshot[] {
  const base = Array.isArray(history) ? history : [];
  const next = [...base, { blocks: { ...blocks }, note, at }];
  return next.length > MAX_SETTING_HISTORY ? next.slice(next.length - MAX_SETTING_HISTORY) : next;
}

// 一键回退「上一步」：弹出最近一条快照，返回它的 blocks 与裁剪后的历史；空历史返回 null。
export function popSnapshot(
  history: SettingSnapshot[] | undefined,
): { restored: SettingSnapshot | null; history: SettingSnapshot[] } {
  const base = Array.isArray(history) ? history : [];
  if (base.length === 0) return { restored: null, history: [] };
  const restored = base[base.length - 1];
  return { restored, history: base.slice(0, -1) };
}
