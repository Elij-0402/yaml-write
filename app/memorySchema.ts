// FR-MEM 记忆底盘（卷-章-幕三级大纲 + 设定卡）与 FR-EDT 草稿快照的「本地持久化形状单一源」。
// 被 app/db.ts import 用于 Table<T, string> 声明（镜像 app/dnaSchema.ts 的单一源模式）。
// 铁律：本模块不得 import 'dexie' 或 './db'——import db.ts 即 new NovelFusionDB() 触发 IndexedDB 打开，
// node 测试环境下会崩；把可测的类型/枚举/守卫下沉到这里，故 memorySchema.test.ts 可在 node 纯逻辑单测。
//
// 三级父子链：novels(既有 DNA 源书，复用) → volumes → outlineChapters → scenes；
// entityCards 挂在 novels 下、draftHistory 挂在 scenes 下。各表冗余存 novelId 便于「按书直查」与级联删。
// 全部 camelCase、主键 id:string（应用侧 crypto.randomUUID() 生成，禁 ++id 自增）、外键 [parent]Id、时间戳 epoch ms。

export interface Volume {            // 卷（三级大纲顶层）
  id: string;
  novelId: string;                   // FK → 既有 novels.id
  title: string;
  order: number;                     // 同一 novel 内排序（拖拽重排写回）
  createdAt: number;                 // epoch ms
  updatedAt: number;
}

export interface OutlineChapter {    // 章（三级大纲中层）—— 注意：独立于既有 DNA `chapters` 表
  id: string;
  novelId: string;                   // 冗余：便于按书直查 / 级联删
  volumeId: string;                  // FK → volumes.id
  title: string;
  order: number;                     // 同一 volume 内排序
  createdAt: number;
  updatedAt: number;
}

export interface Scene {             // 幕（写作与 AI 生成的最小工作单元，FR-MEM-001）
  id: string;
  novelId: string;                   // 冗余
  chapterId: string;                 // FK → outlineChapters.id（不是 DNA chapters）
  title: string;
  order: number;
  synopsis: string;                  // 细纲（FR-MEM-003 Harness 装配输入；缺省 ''）
  content: string;                   // 幕正文（AI 起草 / 手写；缺省 ''）
  wordCount: number;                 // 缺省 0
  createdAt: number;
  updatedAt: number;
}

export type EntityCardType = 'worldview' | 'character' | 'prop' | 'geography'; // 世界规章/人物/道具/地理（FR-MEM-002）
export type EntityActiveState = 'sceneActive' | 'globalActive' | 'idle';        // 当前场景活跃/全局活跃/闲置（FR-MEM-003 / Story 2.3）

export interface EntityCard {        // 设定卡
  id: string;
  novelId: string;                   // FK → novels.id
  type: EntityCardType;
  name: string;
  summary: string;                   // 卡面简述（缺省 ''）
  details: string;                   // 详细设定正文（缺省 ''）
  activeState: EntityActiveState;    // 缺省 'idle'
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface DraftHistory {      // 草稿快照（FR-EDT-003 / Story 4.3，每幕最多 10）
  id: string;
  novelId: string;                   // 冗余
  sceneId: string;                   // FK → scenes.id（快照归属的幕）
  text: string;                      // 归档的正文快照
  label?: string;                    // 版本标签（如 "Version 3"），可选
  createdAt: number;
}

export const ENTITY_CARD_TYPES = ['worldview', 'character', 'prop', 'geography'] as const;
export const ENTITY_ACTIVE_STATES = ['sceneActive', 'globalActive', 'idle'] as const;
// FR-EDT-003 每幕草稿快照上限（供 Story 4.3 复用，避免魔法数字分散）。
export const DRAFT_HISTORY_MAX_PER_SCENE = 10;

// 类型守卫（参照 db.ts:isWinnerStrategyId 写法）：防呆校验外部/持久化数据的枚举字段。
export function isEntityCardType(v: unknown): v is EntityCardType {
  return typeof v === 'string' && (ENTITY_CARD_TYPES as readonly string[]).includes(v);
}
export function isEntityActiveState(v: unknown): v is EntityActiveState {
  return typeof v === 'string' && (ENTITY_ACTIVE_STATES as readonly string[]).includes(v);
}
