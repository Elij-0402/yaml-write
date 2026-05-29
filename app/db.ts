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
}

export interface Chapter {
  id: string;
  novelId: string;
  chapterIndex: number;
  name: string;
  wordCount: number;
  content: string;
  status: 'unparsed' | 'parsing' | 'done' | 'error';
  analysis?: ChapterAnalysis;
  errorMsg?: string;
  parsingSessionId?: string;
  parsingOwnerId?: string;
}

class NovelFusionDB extends Dexie {
  novels!: Table<Novel>;
  chapters!: Table<Chapter>;

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
  }
}

export const db = new NovelFusionDB();
