// 前端 DNA / 融合数据结构的「唯一形状源」（single source of truth）。
// 仓库铁律：这些 shape 与 api/schemas.py 逐字段 camelCase 对齐（后端 Pydantic 驱动 instructor 抽取）。
// 此前 db.ts / FusionWorkshop.tsx 各自定义、靠人工同步——现收成单一源，二者改为从此 import。
// 文件末尾的 parseX 适配器供 llmClient.callStructured 在解析步做轻量运行时校验，替代过网络的裸 `as T`。

// ① 引擎·结构骨架的功能节拍（Propp 功能；如「废柴受辱」「获得金手指」）。
export interface StructureBeat {
  function: string; // 可迁移功能节拍（题材中立）
  summary: string;  // 该节拍在原书的具体体现（一句话）
}

// 四层「引擎 / 皮」DNA 卡 v2 —— 镜像 api/schemas.py NovelDNACardResponse。
export interface NovelDNACard {
  structureSkeleton: StructureBeat[]; // ① 引擎·结构骨架（typed）
  pacingSyuzhet: string;              // ② 引擎·编排节奏（syuzhet）
  themeSkin: string;                  // ③ 皮·题材世界观意象（自由文本）
  proseStyle: string;                 // ④ 文笔（自由文本；换皮时默认重生成）
}

// 单弧窗 / 单章 Map 摘要 —— 镜像 api/schemas.py ChapterMapSummaryResponse。
export interface ChapterMapSummary {
  worldviewUpdates: string;
  keyPlotTurns: string;
  characterDevelopments: string;
  styleObservations: string;
}

// 创世台四块设定积木。
export type BlockKey = 'worldviewBlock' | 'protagonistBlock' | 'antagonistBlock' | 'narrativeTone';
export type SettingBlocks = Record<BlockKey, string>;

// 一个换皮融合方向 —— 镜像 api/schemas.py FusionDirection。
// transferNote 后端必返，前端按可选处理（旧持久化记录可能缺省）。
export interface FusionDirection {
  title: string;
  concept: string;
  catalyst: string;
  worldviewBlock: string;
  protagonistBlock: string;
  antagonistBlock: string;
  narrativeTone: string;
  transferNote?: string;
}

// === 运行时校验适配器：过网络的结构化返回不再裸 as T；坏 / 缺字段的 JSON 立即抛友好错误 ===
// 后端 instructor 已按 Pydantic 校验过形状，这层为前端的纵深防御（防上游协议漂移 / 半成品落库）。

function requireRecord(json: unknown, ctx: string): Record<string, unknown> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`${ctx}：返回结构异常（期望 JSON 对象）。`);
  }
  return json as Record<string, unknown>;
}

function requireStrings<K extends string>(obj: Record<string, unknown>, keys: readonly K[], ctx: string): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v !== 'string') throw new Error(`${ctx}：缺少或非法字段「${k}」。`);
    out[k] = v;
  }
  return out;
}

export function parseChapterMapSummary(json: unknown): ChapterMapSummary {
  const obj = requireRecord(json, '章节摘要');
  return requireStrings(obj, ['worldviewUpdates', 'keyPlotTurns', 'characterDevelopments', 'styleObservations'], '章节摘要');
}

export function parseStructureBeat(json: unknown, ctx: string): StructureBeat {
  const obj = requireRecord(json, ctx);
  return requireStrings(obj, ['function', 'summary'], ctx);
}

export function parseNovelDNACard(json: unknown): NovelDNACard {
  const obj = requireRecord(json, 'DNA 卡');
  const skeleton = obj.structureSkeleton;
  if (!Array.isArray(skeleton) || skeleton.length === 0) {
    throw new Error('DNA 卡：structureSkeleton 须为非空数组。');
  }
  const structureSkeleton = skeleton.map((beat, i) => parseStructureBeat(beat, `DNA 卡·节拍[${i}]`));
  const strings = requireStrings(obj, ['pacingSyuzhet', 'themeSkin', 'proseStyle'], 'DNA 卡');
  return { structureSkeleton, ...strings };
}

export function parseFusionDirection(json: unknown, ctx: string): FusionDirection {
  const obj = requireRecord(json, ctx);
  const core = requireStrings(
    obj,
    ['title', 'concept', 'catalyst', 'worldviewBlock', 'protagonistBlock', 'antagonistBlock', 'narrativeTone'],
    ctx,
  );
  const direction: FusionDirection = { ...core };
  if (obj.transferNote !== undefined) {
    if (typeof obj.transferNote !== 'string') throw new Error(`${ctx}：transferNote 非法（须为字符串）。`);
    direction.transferNote = obj.transferNote;
  }
  return direction;
}

export function parseFusionDirections(json: unknown): { directions: FusionDirection[] } {
  const obj = requireRecord(json, '融合方向');
  const arr = obj.directions;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('融合方向：directions 须为非空数组。');
  }
  return { directions: arr.map((d, i) => parseFusionDirection(d, `融合方向[${i}]`)) };
}
