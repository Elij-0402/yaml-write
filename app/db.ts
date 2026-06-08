import Dexie, { type Table } from 'dexie';
import type { ChapterMapSummary, FusionDirection, NovelDNACard } from './dnaSchema';

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

// Book-level DNA 形状（ChapterMapSummary / StructureBeat / NovelDNACard）现由 app/dnaSchema.ts 单一源定义并 import。

// 存量 5 维卡：惰性迁移保留原文不丢（决策 B）。仅在重新提取时升级为 4 层 NovelDNACard。
export interface LegacyNovelDNACard {
  theme: string;
  worldview: string;
  characters: string;
  narrativeStyle: string;
  styleFingerprint: string;
}

// dnaCard 为联合类型：用守卫区分 4 层新卡与 5 维旧卡，避免读取时误判形状。
export function isLegacyDnaCard(
  card: NovelDNACard | LegacyNovelDNACard | null | undefined,
): card is LegacyNovelDNACard {
  return !!card && 'theme' in card && !('structureSkeleton' in card);
}
export function isFourLayerDnaCard(
  card: NovelDNACard | LegacyNovelDNACard | null | undefined,
): card is NovelDNACard {
  return !!card && 'structureSkeleton' in card;
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
  // book-level DNA (extraction)
  analysisStatus: AnalysisStatus;
  mapProgress?: { total: number; current: number };
  dnaCard?: NovelDNACard | LegacyNovelDNACard | null;
  dnaCardVersion?: 1 | 2; // 1 = 旧 5 维（legacy，惰性保留）；2 = 新 4 层。无卡时留空
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
// FusionDirection（融合方向）形状由 app/dnaSchema.ts 单一源定义并 import（与后端 FusionDirection 逐字段同步）。

// 开篇历史版本（v12）：成稿「重写开篇」会先把当前正文归档为一条 draft，最多保留最近 ~5 版，可查看/恢复/对比。
export interface OpeningDraft {
  text: string;
  createdAt: number;
  label?: string;
}

export interface FusionSession {
  id: string; // v8 起为按 id 的多记录「创作库」（不再单例 'current'）；每开一轮新融合即一条新记录
  name: string; // 创作名（DB 为单一真相源，侧栏可重命名；回写前 get 既有记录以保留）
  createdAt: number; // 创建时刻（epoch ms，驱动创作库排序；回写前 get 既有记录以保留）
  selectedIds: string[];
  customPrompt: string;
  adversarialRules: string;
  step: 'material' | 'directions' | 'creator' | 'manuscript';
  directions: FusionDirection[];
  blocks: { worldviewBlock: string; protagonistBlock: string; antagonistBlock: string; narrativeTone: string };
  directionTitle: string;
  sceneCount: number;
  sceneTexts: Record<number, string>;
  sceneResumeStatus: Record<number, string>;
  openingDrafts?: OpeningDraft[]; // v12：开篇历史版本（重写前归档，可恢复/对比；缺省视为无历史）
  freedom?: boolean; // v13：生成模式（false=换皮变题默认 / true=0→1 原创）持久化，重载不再回默认
  tone?: string;     // v13：成稿文风寄存器预设键（cold/hot/humor/lyrical；缺省=贴题材）
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
    // v9: DNA 卡重切为 4 层「引擎/皮」(StructureBeat[] + pacingSyuzhet/themeSkin/proseStyle) + FusionSession.settingHistory 版本历史。
    // 索引串与 v8 一致（dnaCard / dnaCardVersion / settingHistory 均非索引）。存量 5 维卡惰性标 legacy：
    // 保留原文不丢、analysisStatus 维持 done，仅打 dnaCardVersion=1；重新提取时才升 4 层（决策 B）。
    this.version(9)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
        fusionSessions: 'id, updatedAt, createdAt',
      })
      .upgrade(async (tx) => {
        await tx.table('novels').toCollection().modify((novel: Partial<Novel>) => {
          // v9 之前的 dnaCard 必为旧 5 维形状——非空即标 legacy(1)；空卡(null)不标，留待提取写 2。
          if (novel.dnaCard && novel.dnaCardVersion === undefined) {
            novel.dnaCardVersion = 1;
          }
        });
        /* settingHistory 为新可选字段，存量创作留空（缺省视为空栈），首次接受 AI 改动时按需创建——不回填以免阻塞启动主线程 */
      });
    // v10: FusionSession 移除废弃的 storyboard 字段（成稿改为单一连续开篇后该字段恒为 []，且从不回读）。
    // 索引串与 v9 完全一致；storyboard 非索引、纯类型层移除，存量记录残留的空数组无害，故 upgrade 为 no-op（不全表重写以免阻塞启动）。
    this.version(10)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
        fusionSessions: 'id, updatedAt, createdAt',
      })
      .upgrade(async () => {
        /* storyboard 移除为纯类型层变更，存量数据无需迁移 */
      });
    // v11: 创世台收拢——移除 FusionSession.settingHistory（diff 预览 / 版本历史已删，AI 改动改为直接套用）。
    // 索引串与 v10 一致；settingHistory 非索引、纯类型层移除。存量残留的快照栈主动删除，避免无主数据长存。
    this.version(11)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
        fusionSessions: 'id, updatedAt, createdAt',
      })
      .upgrade(async (tx) => {
        await tx.table('fusionSessions').toCollection().modify((s: Record<string, unknown>) => {
          delete s.settingHistory;
        });
      });
    // v12: FusionSession 新增 openingDrafts（开篇历史版本，可选、非索引）。索引串与 v11 一致。
    // 新可选字段，存量创作留空（缺省视为无历史），首次「重写开篇」时按需归档——不回填以免阻塞启动主线程。
    this.version(12)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
        fusionSessions: 'id, updatedAt, createdAt',
      })
      .upgrade(async () => {
        /* openingDrafts 为新可选字段，存量无需迁移 */
      });
    // v13: FusionSession 新增 freedom（生成模式）+ tone（成稿文风寄存器），均可选、非索引。索引串与 v12 一致。
    // 新可选字段，存量留空（freedom 缺省 false=换皮 / tone 缺省=贴题材）——不回填以免阻塞启动主线程。
    this.version(13)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
        fusionSessions: 'id, updatedAt, createdAt',
      })
      .upgrade(async () => {
        /* freedom / tone 为新可选字段，存量无需迁移 */
      });
  }
}

export const db = new NovelFusionDB();
