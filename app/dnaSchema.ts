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

// === 阶段五点二：质检三把锁与评估报告 (Story 3.2) ===

export interface SelectedDirection {
  title: string;
  worldviewBlock: string;
  protagonistBlock: string;
  antagonistBlock: string;
  narrativeTone: string;
}

export interface StoryboardScene {
  sceneNumber: number;
  sceneTitle: string;
  plotOutline: string;
  tensionLevel: string;
  visualCues: string;
}

export interface ActiveCardItem {
  name: string;
  type: 'worldview' | 'character' | 'prop' | 'geography' | '';
  summary: string;
  details: string;
  activeState: 'sceneActive' | 'globalActive' | 'idle' | '';
}

export interface SceneEvaluateInput {
  sceneId: string;
  attempt: number;
  draft: string;
  selectedDirection: SelectedDirection;
  currentScene: StoryboardScene;
  activeCards: ActiveCardItem[];
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

export interface SceneAuditResult {
  styleLock: GateResult;
  consistencyLock: GateResult;
  outlineLock: GateResult;
  actionableFeedback: string;
}

export interface SceneEvaluateResponse {
  sceneId: string;
  attempt: number;
  passed: boolean;
  failedGates: string[];
  evidence: string;
  actionableFeedback: string;
}

export function parseSceneEvaluateResponse(json: unknown): SceneEvaluateResponse {
  const obj = requireRecord(json, '评估报告');
  if (typeof obj.sceneId !== 'string') throw new Error('评估报告：sceneId 须为字符串。');
  if (typeof obj.attempt !== 'number') throw new Error('评估报告：attempt 须为数字。');
  if (typeof obj.passed !== 'boolean') throw new Error('评估报告：passed 须为布尔值。');
  if (typeof obj.evidence !== 'string') throw new Error('评估报告：evidence 须为字符串。');
  if (typeof obj.actionableFeedback !== 'string') throw new Error('评估报告：actionableFeedback 须为字符串。');

  if (!Array.isArray(obj.failedGates)) {
    throw new Error('评估报告：failedGates 须为数组。');
  }
  for (const item of obj.failedGates) {
    if (typeof item !== 'string') {
      throw new Error('评估报告：failedGates 元素须为字符串。');
    }
  }

  return {
    sceneId: obj.sceneId,
    attempt: obj.attempt,
    passed: obj.passed,
    failedGates: obj.failedGates as string[],
    evidence: obj.evidence,
    actionableFeedback: obj.actionableFeedback,
  };
}

// === Story 3.4: 对话智能意图解析与设定自动更新 ===

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface VolumeItem {
  id: string;
  title: string;
  order: number;
}

export interface ChapterItem {
  id: string;
  volumeId: string;
  title: string;
  order: number;
}

export interface SceneItem {
  id: string;
  chapterId: string;
  title: string;
  synopsis: string;
  order: number;
}

export interface EntityCardUpdate {
  action: 'upsert' | 'delete';
  cardId: string;
  type: 'worldview' | 'character' | 'prop' | 'geography';
  name: string;
  summary: string;
  details: string;
}

export interface VolumeUpdate {
  action: 'upsert' | 'delete';
  volume: VolumeItem;
}

export interface ChapterUpdate {
  action: 'upsert' | 'delete';
  chapter: ChapterItem;
}

export interface SceneUpdate {
  action: 'upsert' | 'delete';
  scene: SceneItem;
}

export interface ChatAssistantResponse {
  reply: string;
  entityCardUpdates: EntityCardUpdate[];
  volumeUpdates: VolumeUpdate[];
  chapterUpdates: ChapterUpdate[];
  sceneUpdates: SceneUpdate[];
}

export function parseChatAssistantResponse(json: unknown): ChatAssistantResponse {
  const obj = requireRecord(json, 'AI 助手响应');
  if (typeof obj.reply !== 'string') throw new Error('AI 助手响应：reply 须为字符串。');

  const entityCardUpdates = Array.isArray(obj.entityCardUpdates) ? obj.entityCardUpdates : [];
  for (let i = 0; i < entityCardUpdates.length; i++) {
    const item = requireRecord(entityCardUpdates[i], `entityCardUpdates[${i}]`);
    if (item.action !== 'upsert' && item.action !== 'delete') {
      throw new Error(`entityCardUpdates[${i}]：action 须为 "upsert" 或 "delete"。`);
    }
    if (typeof item.cardId !== 'string') throw new Error(`entityCardUpdates[${i}]：cardId 须为字符串。`);
    if (item.action === 'upsert') {
      if (typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error(`entityCardUpdates[${i}]：upsert 操作须提供非空 name。`);
      }
    }
  }

  const volumeUpdates = Array.isArray(obj.volumeUpdates) ? obj.volumeUpdates : [];
  for (let i = 0; i < volumeUpdates.length; i++) {
    const item = requireRecord(volumeUpdates[i], `volumeUpdates[${i}]`);
    if (item.action !== 'upsert' && item.action !== 'delete') {
      throw new Error(`volumeUpdates[${i}]：action 须为 "upsert" 或 "delete"。`);
    }
    const vol = item.volume;
    if (!vol || typeof vol !== 'object') {
      throw new Error(`volumeUpdates[${i}]：须包含 volume 对象。`);
    }
  }

  const chapterUpdates = Array.isArray(obj.chapterUpdates) ? obj.chapterUpdates : [];
  for (let i = 0; i < chapterUpdates.length; i++) {
    const item = requireRecord(chapterUpdates[i], `chapterUpdates[${i}]`);
    if (item.action !== 'upsert' && item.action !== 'delete') {
      throw new Error(`chapterUpdates[${i}]：action 须为 "upsert" 或 "delete"。`);
    }
    const ch = item.chapter;
    if (!ch || typeof ch !== 'object') {
      throw new Error(`chapterUpdates[${i}]：须包含 chapter 对象。`);
    }
  }

  const sceneUpdates = Array.isArray(obj.sceneUpdates) ? obj.sceneUpdates : [];
  for (let i = 0; i < sceneUpdates.length; i++) {
    const item = requireRecord(sceneUpdates[i], `sceneUpdates[${i}]`);
    if (item.action !== 'upsert' && item.action !== 'delete') {
      throw new Error(`sceneUpdates[${i}]：action 须为 "upsert" 或 "delete"。`);
    }
    const sc = item.scene;
    if (!sc || typeof sc !== 'object') {
      throw new Error(`sceneUpdates[${i}]：须包含 scene 对象。`);
    }
  }

  return {
    reply: obj.reply as string,
    entityCardUpdates: entityCardUpdates as EntityCardUpdate[],
    volumeUpdates: volumeUpdates as VolumeUpdate[],
    chapterUpdates: chapterUpdates as ChapterUpdate[],
    sceneUpdates: sceneUpdates as SceneUpdate[],
  };
}
