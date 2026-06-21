// 设定卡（entityCards）的「纯规划」层：只算末位 order、删除后压缩重排、按 type 固定顺序分组装配。
// 不碰 db / crypto / setState —— 组件读 useLiveQuery 拿到数组后调本模块算规划，再在一个 db.transaction 内套用
//（镜像 app/outlineOps.ts 的「纯规划层 + db.transaction」范式）。铁律：本模块不得 import 'dexie' 或 './db'
//（import db.ts 即 new NovelFusionDB() 触发 IndexedDB 打开，node 测试环境会崩），仅 import type / 常量 from './memorySchema'。
// 抽出后这些下标 / 边界 / 集合算术可在 node 纯逻辑单测（见 app/entityCardOps.test.ts）。

import type { EntityCard, EntityCardType } from './memorySchema';
import { ENTITY_CARD_TYPES } from './memorySchema';

// 四类设定卡的中文展示标签（单一源）：EntityCardEditor 的类型选择器与 EntityCardLibrary 的分组标题共用。
// 放在这个无 React / 无 Dexie 的纯模块里，避免「Library 渲染 Editor、Editor 又反向 import Library」的循环依赖。
export const ENTITY_CARD_TYPE_LABELS: Record<EntityCardType, string> = {
  worldview: '世界规章',
  character: '人物',
  prop: '道具',
  geography: '地理',
};

// order 采用 0 基：同一 (novelId, type) 组内卡片排序为连续的 0..n-1（与 outlineOps 一致）。
const ORDER_START = 0;

// —— 末位 order：在某 (novelId, type) 组下新增卡片时取「现有最大 order + 1」；空集从 ORDER_START 起 ——
// 组件调用时传入「同一 (novelId, type) 组」已读出的卡片（即将分组内排序的兄弟集合）。
export function nextOrder(siblings: ReadonlyArray<{ order: number }>): number {
  if (siblings.length === 0) return ORDER_START;
  return Math.max(...siblings.map((s) => s.order)) + 1;
}

export interface OrderEntry {
  id: string;
  order: number;
}

// 内部：按当前 order 升序得到稳定的视觉顺序（order 相等时按入参原顺序，保证确定性）。
function sortByOrder<T extends { order: number }>(cards: ReadonlyArray<T>): T[] {
  return cards.map((c, i) => ({ c, i })).sort((a, b) => a.c.order - b.c.order || a.i - b.i).map(({ c }) => c);
}

// —— 删除后压缩：把同 (novelId, type) 组剩余卡片按当前 order 重排为连续 0..n-1，消除删除留下的空洞 ——
// 与 outlineOps.reindexSiblings 同构；组件取「仅 order 变化项」在单个 db.transaction 内批量 update。
export function reindexCards(siblings: ReadonlyArray<{ id: string; order: number }>): OrderEntry[] {
  return sortByOrder(siblings).map((s, i) => ({ id: s.id, order: i }));
}

export interface EntityCardGroup {
  type: EntityCardType;
  cards: EntityCard[];
}

// —— 分组装配：把（已按 novelId 过滤的）卡片数组按 ENTITY_CARD_TYPES 固定顺序分到 4 组 ——
// 始终返回 4 组（空组 cards: []），每组内按 order 升序、相等 order 以入参原序 tie-break（确定性）。
// 未知 type 的游离卡做确定性丢弃（理论上不会出现——type 受 EntityCardType 约束）。组件渲染时自行决定是否隐藏空组。
export function groupCardsByType(cards: ReadonlyArray<EntityCard>): EntityCardGroup[] {
  const byType = new Map<EntityCardType, EntityCard[]>();
  for (const type of ENTITY_CARD_TYPES) byType.set(type, []);
  // 先按入参顺序入桶（保留原序作为相等 order 的 tie-break 基准），再在 sortByOrder 内稳定排序。
  for (const card of cards) {
    const bucket = byType.get(card.type);
    if (!bucket) continue; // 未知 type → 丢弃，不渲染游离卡
    bucket.push(card);
  }
  return ENTITY_CARD_TYPES.map((type) => ({ type, cards: sortByOrder(byType.get(type)!) }));
}
