import Dexie, { type Table } from 'dexie';

export interface Character {
  name: string;
  personality: string;
  appearance: string;
  coreConflict: string;
  chapters: string;
}

export interface Relationship {
  roleA: string;
  roleB: string;
  description: string;
}

export interface ChapterAnalysis {
  worldview: string;
  plotSkeleton: string;
  characters: Character[];
  relationships: Relationship[];
  style: string;
}

// === Book-level DNA (v5 Map-Reduce) — mirrors api/schemas.py (camelCase) ===
export interface ChapterMapSummary {
  worldviewUpdates: string;
  keyPlotTurns: string;
  characterDevelopments: string;
  styleObservations: string;
}

export interface NovelDNACard {
  theme: string;
  worldview: string;
  characters: string;
  narrativeStyle: string;
  styleFingerprint: string;
}

export type AnalysisStatus = 'idle' | 'mapping' | 'reducing' | 'done' | 'error';
export type MapStatus = 'pending' | 'mapping' | 'done' | 'error';

export type SplitStatus = 'ok' | 'needs_review';

export type SplitStrategyId = 'auto_v2' | 'zh_strict' | 'zh_extended' | 'mixed' | 'en_basic' | 'custom';
export type WinnerStrategyId = Exclude<SplitStrategyId, 'auto_v2'>;
export type SplitSelectionMode = 'manual' | 'auto_v2';

export type SplitConfidenceLevel = 'high' | 'medium' | 'low';

export interface SplitMeta {
  strategyId: SplitStrategyId;
  selectionMode: SplitSelectionMode;
  winnerStrategyId?: WinnerStrategyId;
  chapterCount: number;
  avgChapterChars: number;
  maxChapterRatio: number;
  shortChapterRatio: number;
  confidence: number;
  confidenceLevel: SplitConfidenceLevel;
  reviewReasons: string[];
  titleHitRate: number | null;
  continuityScore: number | null;
  distributionScore: number | null;
  engineVersion: 'v1' | 'v2';
  updatedAt: number;
}

function isWinnerStrategyId(value: unknown): value is WinnerStrategyId {
  return value === 'zh_strict'
    || value === 'zh_extended'
    || value === 'mixed'
    || value === 'en_basic'
    || value === 'custom';
}

export interface Novel {
  id: string;
  name: string;
  wordCount: number;
  createdAt: number;
  purifiedCount?: number;
  sourceTextCleaned: string;
  splitStatus: SplitStatus;
  splitMeta?: SplitMeta;
  // v5 book-level DNA (Map-Reduce)
  analysisStatus: AnalysisStatus;
  mapProgress?: { total: number; current: number };
  dnaCard?: NovelDNACard | null;
}

export interface Chapter {
  id: string;
  novelId: string;
  chapterIndex: number;
  name: string;
  wordCount: number;
  content: string;
  contentSha256?: string; // 增量测序校验哈希；由 Story 1.2 写入 / 2.2 精测时按需填充
  status: 'unparsed' | 'parsing' | 'done' | 'error';
  analysis?: ChapterAnalysis; // deprecated since v5 — replaced by mapSummary
  errorMsg?: string;
  parsingSessionId?: string;
  parsingOwnerId?: string;
  // v5 Map phase
  mapStatus: MapStatus;
  mapSummary?: ChapterMapSummary;
  mapCompletedAt?: number; // epoch ms when this chapter's Map finished — drives Live Feed completion order
}

// === Fusion workshop session (v7) — persists the融合工坊 funnel so a refresh/sidebar-click never蒸发已生成的方向/积木/正文 ===
export interface FusionDirectionRecord {
  title: string;
  concept: string;
  catalyst: string;
  worldviewBlock: string;
  protagonistBlock: string;
  antagonistBlock: string;
  narrativeTone: string;
}

export interface StoryboardSceneRecord {
  sceneNumber: number;
  sceneTitle: string;
  plotOutline: string;
  tensionLevel: string;
  visualCues: string;
}

export interface FusionSession {
  id: string; // v8 起为按 id 的多记录「创作库」（不再单例 'current'）；每开一轮新融合即一条新记录
  name: string; // 创作名（DB 为单一真相源，侧栏可重命名；回写前 get 既有记录以保留）
  createdAt: number; // 创建时刻（epoch ms，驱动创作库排序；回写前 get 既有记录以保留）
  selectedIds: string[];
  customPrompt: string;
  adversarialRules: string;
  step: 'material' | 'directions' | 'creator';
  directions: FusionDirectionRecord[];
  blocks: { worldviewBlock: string; protagonistBlock: string; antagonistBlock: string; narrativeTone: string };
  directionTitle: string;
  sceneCount: number;
  storyboard: StoryboardSceneRecord[];
  sceneTexts: Record<number, string>;
  sceneResumeStatus: Record<number, string>;
  updatedAt: number;
}

class NovelFusionDB extends Dexie {
  novels!: Table<Novel, string>;
  chapters!: Table<Chapter, string>;
  fusionSessions!: Table<FusionSession, string>;

  constructor() {
    super('NovelFusionDB');
    this.version(1).stores({
      novels: 'id, name, createdAt',
      chapters: 'id, novelId, chapterIndex, status',
    });
    this.version(2)
      .stores({
        novels: 'id, name, createdAt, splitStatus',
        chapters: 'id, novelId, chapterIndex, status',
      })
      .upgrade(async (tx) => {
        const novelsTable = tx.table('novels');
        await novelsTable.toCollection().modify((novel: Partial<Novel>) => {
          if (!novel.splitStatus) {
            novel.splitStatus = 'ok';
          }
          if (typeof novel.sourceTextCleaned !== 'string') {
            novel.sourceTextCleaned = '';
          }
        });
      });
    this.version(3)
      .stores({
        novels: 'id, name, createdAt, splitStatus',
        chapters: 'id, novelId, chapterIndex, status',
      })
      .upgrade(async (tx) => {
        const novelsTable = tx.table('novels');
        await novelsTable.toCollection().modify((novel: Partial<Novel>) => {
          if (!novel.splitStatus) {
            novel.splitStatus = 'ok';
          }
          if (typeof novel.sourceTextCleaned !== 'string') {
            novel.sourceTextCleaned = '';
          }
          if (novel.splitMeta) {
            novel.splitMeta = {
              ...novel.splitMeta,
              confidence: typeof novel.splitMeta.confidence === 'number' ? novel.splitMeta.confidence : 0.5,
              confidenceLevel: novel.splitMeta.confidenceLevel || 'medium',
              reviewReasons: Array.isArray(novel.splitMeta.reviewReasons) ? novel.splitMeta.reviewReasons : [],
              titleHitRate: typeof novel.splitMeta.titleHitRate === 'number' ? novel.splitMeta.titleHitRate : null,
              continuityScore: typeof novel.splitMeta.continuityScore === 'number' ? novel.splitMeta.continuityScore : null,
              distributionScore: typeof novel.splitMeta.distributionScore === 'number' ? novel.splitMeta.distributionScore : null,
              selectionMode: novel.splitMeta.selectionMode === 'auto_v2'
                ? 'auto_v2'
                : (novel.splitMeta.strategyId === 'auto_v2' ? 'auto_v2' : 'manual'),
              winnerStrategyId: isWinnerStrategyId(novel.splitMeta.winnerStrategyId)
                ? novel.splitMeta.winnerStrategyId
                : (novel.splitMeta.strategyId !== 'auto_v2' && isWinnerStrategyId(novel.splitMeta.strategyId)
                  ? novel.splitMeta.strategyId
                  : undefined),
              engineVersion: novel.splitMeta.engineVersion || 'v1',
            } as SplitMeta;
          }
        });
      });
    this.version(4)
      .stores({
        novels: 'id, name, createdAt, splitStatus',
        chapters: 'id, novelId, chapterIndex, status',
      })
      .upgrade(async (tx) => {
        const novelsTable = tx.table('novels');
        await novelsTable.toCollection().modify((novel: Partial<Novel>) => {
          if (!novel.splitMeta) return;
          const meta = novel.splitMeta as Partial<SplitMeta>;

          const confidence = typeof meta.confidence === 'number' ? meta.confidence : 0.5;
          const confidenceLevel = meta.confidenceLevel || 'medium';
          const reviewReasons = Array.isArray(meta.reviewReasons) ? meta.reviewReasons : [];
          const titleHitRate = typeof meta.titleHitRate === 'number' ? meta.titleHitRate : null;
          const continuityScore = typeof meta.continuityScore === 'number' ? meta.continuityScore : null;
          const distributionScore = typeof meta.distributionScore === 'number' ? meta.distributionScore : null;
          const syntheticLegacyMetrics = titleHitRate === 0
            && continuityScore === 0
            && distributionScore === 0.5
            && confidence === 0.5
            && confidenceLevel === 'medium'
            && reviewReasons.length === 0
            && meta.selectionMode === undefined
            && meta.winnerStrategyId === undefined;

          const strategyId = meta.strategyId || 'custom';
          const selectionMode: SplitSelectionMode = meta.selectionMode === 'auto_v2'
            ? 'auto_v2'
            : (strategyId === 'auto_v2' ? 'auto_v2' : 'manual');
          const winnerStrategyId = isWinnerStrategyId(meta.winnerStrategyId)
            ? meta.winnerStrategyId
            : (strategyId !== 'auto_v2' && isWinnerStrategyId(strategyId) ? strategyId : undefined);

          novel.splitMeta = {
            ...meta,
            strategyId,
            selectionMode,
            winnerStrategyId,
            confidence,
            confidenceLevel,
            reviewReasons,
            titleHitRate: syntheticLegacyMetrics ? null : titleHitRate,
            continuityScore: syntheticLegacyMetrics ? null : continuityScore,
            distributionScore: syntheticLegacyMetrics ? null : distributionScore,
            engineVersion: meta.engineVersion || 'v1',
            updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now(),
          } as SplitMeta;
        });
      });
    this.version(5)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
      })
      .upgrade(async (tx) => {
        await tx.table('novels').toCollection().modify((novel: Partial<Novel>) => {
          novel.analysisStatus = novel.analysisStatus || 'idle';
          novel.mapProgress = novel.mapProgress || { total: 0, current: 0 };
          if (novel.dnaCard === undefined) {
            novel.dnaCard = null;
          }
        });
        await tx.table('chapters').toCollection().modify((chapter: Partial<Chapter>) => {
          chapter.mapStatus = chapter.mapStatus || 'pending';
        });
      });
    // v6: 新增 Chapter.contentSha256（可选、非索引）——遵循仓库铁律为形状变更显式登记版本。
    // 索引串与 v5 完全一致；contentSha256 非索引，故不出现在 stores 串中。
    this.version(6)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
      })
      .upgrade(async () => {
        /* contentSha256 为可选字段，存量章节留空，由后续写入(1.2)/精测(2.2)按需回填；此处严禁全量重算以免启动时阻塞主线程 */
      });
    // v7: 新增 fusionSessions 表持久化融合工坊会话。仅建表，存量无需回填（首次进入工坊时按需创建）。
    this.version(7)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
        fusionSessions: 'id, updatedAt',
      })
      .upgrade(async () => {
        /* 新表无存量数据；不回填以免启动时阻塞主线程 */
      });
    // v8: fusionSessions 由单例升级为按 id 的多记录「创作库」——新增 createdAt 索引并回填 name/createdAt，
    // 把旧 'current' 单例会话平滑保留为库的一条创作（零数据丢失）。novels/chapters 索引串与 v7 一致。
    this.version(8)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
        fusionSessions: 'id, updatedAt, createdAt',
      })
      .upgrade(async (tx) => {
        await tx.table('fusionSessions').toCollection().modify((s: Partial<FusionSession>) => {
          if (typeof s.name !== 'string' || !s.name) {
            s.name = s.directionTitle?.trim() || '未命名创作';
          }
          if (typeof s.createdAt !== 'number') {
            s.createdAt = s.updatedAt || Date.now();
          }
        });
      });
  }
}

export const db = new NovelFusionDB();
