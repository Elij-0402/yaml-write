// 大纲（卷-章-幕三级）的「纯规划」层：只算末位 order、同级重排映射、删除后压缩重排、级联删除 id 收集、树装配。
// 不碰 db / crypto / setState —— 组件读 useLiveQuery 拿到数组后调本模块算规划，再在一个 db.transaction 内套用
//（镜像 app/chapterOps.ts 的「纯规划层 + db.transaction」范式）。铁律：本模块不得 import 'dexie' 或 './db'
// （import db.ts 即 new NovelFusionDB() 触发 IndexedDB 打开，node 测试环境会崩），仅 import type from './memorySchema'。
// 抽出后这些下标 / 边界 / 集合算术可在 node 纯逻辑单测（见 app/outlineOps.test.ts）。

import type { Volume, OutlineChapter, Scene } from './memorySchema';

// order 采用 0 基：同父级兄弟排序为连续的 0..n-1。
const ORDER_START = 0;

// —— 末位 order：在某父级下新增兄弟时取「现有最大 order + 1」；空集从 ORDER_START 起 ——
export function nextOrder(siblings: ReadonlyArray<{ order: number }>): number {
  if (siblings.length === 0) return ORDER_START;
  return Math.max(...siblings.map((s) => s.order)) + 1;
}

export interface OrderEntry {
  id: string;
  order: number;
}

// 内部：按当前 order 升序得到稳定的视觉顺序（order 相等时按入参原顺序，保证确定性）。
function sortByOrder<T extends { id: string; order: number }>(siblings: ReadonlyArray<T>): T[] {
  return siblings.map((s, i) => ({ s, i })).sort((a, b) => a.s.order - b.s.order || a.i - b.i).map(({ s }) => s);
}

// —— 同级重排：把 movedId 从当前位置移动到 targetIndex，全组重排为连续 0..n-1 全量映射 ——
// targetIndex 越界自动夹取到 [0, n-1]；movedId 不在组内则原样压缩重排（等价 reindexSiblings）。
export function planReorder(
  siblings: ReadonlyArray<{ id: string; order: number }>,
  movedId: string,
  targetIndex: number,
): OrderEntry[] {
  const ordered = sortByOrder(siblings);
  const fromIdx = ordered.findIndex((s) => s.id === movedId);
  if (fromIdx === -1) return ordered.map((s, i) => ({ id: s.id, order: i }));

  const [moved] = ordered.splice(fromIdx, 1);
  const clamped = Math.max(0, Math.min(targetIndex, ordered.length));
  ordered.splice(clamped, 0, moved);
  return ordered.map((s, i) => ({ id: s.id, order: i }));
}

// —— 删除后压缩：把剩余兄弟按当前 order 重排为连续 0..n-1，消除删除留下的空洞 ——
export function reindexSiblings(siblings: ReadonlyArray<{ id: string; order: number }>): OrderEntry[] {
  return sortByOrder(siblings).map((s, i) => ({ id: s.id, order: i }));
}

export type OutlineLevel = 'volume' | 'chapter' | 'scene';

export interface CascadeResult {
  volumeIds: string[];   // 待删的卷（删卷时含其自身；删章/幕时为空）
  chapterIds: string[];  // 待删的章
  sceneIds: string[];    // 待删的幕（draftHistory 由组件按 sceneIds 清理）
}

// —— 级联删除 id 收集（仅算 id，不碰 db）——
// 删卷 → 自身 + 其全部章 + 这些章下全部幕；删章 → 自身 + 其全部幕；删幕 → 仅自身。
// draftHistory 不在此收集（无 scene 外的归属歧义）：组件按返回的 sceneIds 一并清理。
export function collectCascade(
  target: { level: OutlineLevel; id: string },
  data: {
    chapters: ReadonlyArray<Pick<OutlineChapter, 'id' | 'volumeId'>>;
    scenes: ReadonlyArray<Pick<Scene, 'id' | 'chapterId'>>;
  },
): CascadeResult {
  if (target.level === 'scene') {
    return { volumeIds: [], chapterIds: [], sceneIds: [target.id] };
  }
  if (target.level === 'chapter') {
    const sceneIds = data.scenes.filter((s) => s.chapterId === target.id).map((s) => s.id);
    return { volumeIds: [], chapterIds: [target.id], sceneIds };
  }
  // volume
  const chapterIds = data.chapters.filter((c) => c.volumeId === target.id).map((c) => c.id);
  const chapterIdSet = new Set(chapterIds);
  const sceneIds = data.scenes.filter((s) => chapterIdSet.has(s.chapterId)).map((s) => s.id);
  return { volumeIds: [target.id], chapterIds, sceneIds };
}

// —— 树装配：把（已按 novelId 过滤的）三数组装配为「卷 → 章 → 幕」嵌套树，各级按 order 升序 ——
// 孤儿（父不存在的章 / 幕）做确定性丢弃：只挂接父存在的节点，避免渲染游离记录。
export interface SceneNode {
  scene: Scene;
}
export interface ChapterNode {
  chapter: OutlineChapter;
  scenes: SceneNode[];
}
export interface VolumeNode {
  volume: Volume;
  chapters: ChapterNode[];
}

export function buildOutlineTree(
  volumes: ReadonlyArray<Volume>,
  chapters: ReadonlyArray<OutlineChapter>,
  scenes: ReadonlyArray<Scene>,
): VolumeNode[] {
  const volumeNodes = new Map<string, VolumeNode>();
  const orderedVolumes = sortByOrder(volumes);
  for (const volume of orderedVolumes) {
    volumeNodes.set(volume.id, { volume, chapters: [] });
  }

  const chapterNodes = new Map<string, ChapterNode>();
  for (const chapter of sortByOrder(chapters)) {
    const parent = volumeNodes.get(chapter.volumeId);
    if (!parent) continue; // 孤儿章：父卷不存在 → 丢弃
    const node: ChapterNode = { chapter, scenes: [] };
    chapterNodes.set(chapter.id, node);
    parent.chapters.push(node);
  }

  for (const scene of sortByOrder(scenes)) {
    const parent = chapterNodes.get(scene.chapterId);
    if (!parent) continue; // 孤儿幕：父章不存在（或父章本身是孤儿）→ 丢弃
    parent.scenes.push({ scene });
  }

  return orderedVolumes.map((v) => volumeNodes.get(v.id)!);
}
