// 章节剪辑（合并 / 批量合并 / 裁切）的「纯规划」层：只算合并后正文、删除/新增项、chapterIndex 重排映射、撤销备份结构。
// 不碰 db / setState / crypto —— 组件拿规划结果在一个 db.transaction 内套用（含 async 重算 sha 与 rescoreSplit）。
// 抽出后这些下标 / 边界算术可单测（首章不可前缝、连续多选并入前一保留章、按行裁切边界等）。

// 规划层只需章节的 id / 下标 / 名称 / 正文；完整 Chapter 结构上即为其超集。
export interface ChapterLike {
  id: string;
  chapterIndex: number;
  name: string;
  content: string;
}

export interface ReindexEntry { id: string; chapterIndex: number; }

const CHAPTER_JOIN = '\n\n';

// —— 合并：把某章并入其上一章（首章或未找到 → null，不可前缝）——
export interface StitchPlan {
  keepId: string;          // 被合并进的上一章（保留并更新正文）
  removeId: string;        // 被吸收删除的当前章
  mergedContent: string;   // 上一章 + 当前章 拼接正文
  reindex: ReindexEntry[]; // 删除后，其后章节下标各 -1
}

export function planStitch(chapters: ChapterLike[], chapterId: string): StitchPlan | null {
  const currIdx = chapters.findIndex((c) => c.id === chapterId);
  if (currIdx <= 0) return null;
  const curr = chapters[currIdx];
  const prev = chapters[currIdx - 1];
  const reindex = chapters
    .filter((c) => c.chapterIndex > curr.chapterIndex)
    .map((c) => ({ id: c.id, chapterIndex: c.chapterIndex - 1 }));
  return {
    keepId: prev.id,
    removeId: curr.id,
    mergedContent: prev.content + CHAPTER_JOIN + curr.content,
    reindex,
  };
}

// —— 批量合并：把每段连续选中的章节并入其前一个「保留章」（首章强制为保留，永不被选中）——
export interface BulkStitchPlan {
  merges: { keepId: string; mergedContent: string }[]; // 各保留锚点合并后的正文
  removeIds: string[];                                 // 被吸收删除的章节
  reindex: ReindexEntry[];                             // 删除后剩余章节按当前顺序顺序重排 1..N
}

export function planBulkStitch(chapters: ChapterLike[], selectedIds: ReadonlySet<string>): BulkStitchPlan {
  const firstId = chapters[0]?.id;
  const mergedContent = new Map<string, string>();
  const removeIds: string[] = [];
  let anchor: ChapterLike | null = null;

  for (const ch of chapters) {
    const isSelected = selectedIds.has(ch.id) && ch.id !== firstId;
    if (!isSelected) {
      anchor = ch; // 保留章：成为后续连续选中章的并入锚点
    } else if (anchor) {
      const base = mergedContent.get(anchor.id) ?? anchor.content;
      mergedContent.set(anchor.id, base + CHAPTER_JOIN + ch.content);
      removeIds.push(ch.id);
    }
  }

  const removeSet = new Set(removeIds);
  const reindex = chapters
    .filter((c) => !removeSet.has(c.id))
    .map((c, i) => ({ id: c.id, chapterIndex: i + 1 }));
  const merges = Array.from(mergedContent.entries()).map(([keepId, content]) => ({ keepId, mergedContent: content }));

  return { merges, removeIds, reindex };
}

// —— 裁切：把一章按「原始行下标」切成上下两章 ——
export interface SplitPlan {
  contentA: string;        // 上半（保留在原章）
  contentB: string;        // 下半（新建章节正文）
  newName: string;         // 新章名（原名 + 「(下)」）
  newChapterIndex: number; // 新章下标（原章 + 1）
  reindex: ReindexEntry[]; // 原章之后的章节下标各 +1（为新章腾位）
}

export function planSplit(chapter: ChapterLike, originalLineIdx: number, chapters: ChapterLike[]): SplitPlan {
  const lines = chapter.content.split('\n');
  const contentA = lines.slice(0, originalLineIdx + 1).join('\n').trim();
  const contentB = lines.slice(originalLineIdx + 1).join('\n').trim();
  const reindex = chapters
    .filter((c) => c.chapterIndex > chapter.chapterIndex)
    .map((c) => ({ id: c.id, chapterIndex: c.chapterIndex + 1 }));
  return {
    contentA,
    contentB,
    newName: `${chapter.name} (下)`,
    newChapterIndex: chapter.chapterIndex + 1,
    reindex,
  };
}

// —— 撤销备份结构：全章 id→下标 的 tocMap + 受影响章节快照（localStorage 读写 / 体积校验 / 字段裁剪留在组件）——
export interface StitchBackup<T> {
  novelId: string;
  affectedChapters: T[];
  tocMap: Record<string, number>;
}

export function buildStitchBackup<T>(chapters: ChapterLike[], novelId: string, affectedChapters: T[]): StitchBackup<T> {
  const tocMap: Record<string, number> = {};
  for (const c of chapters) tocMap[c.id] = c.chapterIndex;
  return { novelId, affectedChapters, tocMap };
}
