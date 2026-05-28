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

export type SplitStrategyId = 'zh_strict' | 'zh_extended' | 'mixed' | 'en_basic' | 'custom';

export interface SplitMeta {
  strategyId: SplitStrategyId;
  chapterCount: number;
  avgChapterChars: number;
  maxChapterRatio: number;
  shortChapterRatio: number;
  updatedAt: number;
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
  }
}

export const db = new NovelFusionDB();
