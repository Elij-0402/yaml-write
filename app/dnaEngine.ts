import { db, type Chapter, type ChapterMapSummary, type NovelDNACard } from './db';
import { postWithLlmConfig, readApiErrorMessage } from './llmClient';

// Resumable, concurrency-limited book-level DNA extraction (Map-Reduce).
// Map: one /extract-chapter-map call per chapter, persisted immediately so a
// refresh/crash never loses progress. Reduce: fold all map summaries into one
// NovelDNACard. Re-running skips chapters already mapStatus==='done'.

const MAP_CONCURRENCY = 3;

export type DnaProgressListener = (current: number, total: number) => void;

async function mapOneChapter(chapter: Chapter, signal: AbortSignal): Promise<void> {
  const response = await postWithLlmConfig(
    '/api/py/extract-chapter-map',
    { title: chapter.name, content: chapter.content },
    { signal }
  );
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response));
  }
  const summary = (await response.json()) as ChapterMapSummary;
  await db.chapters.update(chapter.id, { mapStatus: 'done', mapSummary: summary, errorMsg: undefined });
}

/**
 * Extract (or resume extracting) the book-level DNA for a novel.
 * @param limit  cap the scope to the first N chapters (e.g. 100); omit for全量.
 */
export async function runDnaExtraction(
  novelId: string,
  opts: { limit?: number; signal: AbortSignal }
): Promise<void> {
  const { limit, signal } = opts;

  const all = await db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex');
  const scope = typeof limit === 'number' ? all.slice(0, limit) : all;
  if (scope.length === 0) {
    await db.novels.update(novelId, { analysisStatus: 'error' });
    throw new Error('该小说还没有切分出章节，请先切分。');
  }

  const doneCount = scope.filter((c) => c.mapStatus === 'done').length;
  await db.novels.update(novelId, {
    analysisStatus: 'mapping',
    mapProgress: { total: scope.length, current: doneCount },
  });

  // --- Map phase: concurrency-limited worker pool over not-yet-done chapters ---
  const targets = scope.filter((c) => c.mapStatus !== 'done');
  let nextIndex = 0;
  let completed = doneCount;
  let failures = 0;

  const worker = async () => {
    while (!signal.aborted) {
      const i = nextIndex++;
      if (i >= targets.length) return;
      const chapter = targets[i];
      try {
        await db.chapters.update(chapter.id, { mapStatus: 'mapping' });
        await mapOneChapter(chapter, signal);
        completed += 1;
        await db.novels.update(novelId, { mapProgress: { total: scope.length, current: completed } });
      } catch (err) {
        if (signal.aborted) return;
        failures += 1;
        await db.chapters.update(chapter.id, {
          mapStatus: 'error',
          errorMsg: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAP_CONCURRENCY, targets.length) }, worker));

  if (signal.aborted) {
    await db.novels.update(novelId, { analysisStatus: 'idle' });
    return;
  }
  if (failures > 0) {
    await db.novels.update(novelId, { analysisStatus: 'error' });
    throw new Error(`有 ${failures} 个章节解析失败，请点击继续提取重试失败章节。`);
  }

  // --- Reduce phase ---
  await db.novels.update(novelId, { analysisStatus: 'reducing' });
  const novel = await db.novels.get(novelId);
  const mapped = await db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex');
  const mapSummaries = mapped
    .filter((c) => (typeof limit === 'number' ? c.chapterIndex < limit : true) && c.mapSummary)
    .map((c) => c.mapSummary as ChapterMapSummary);

  try {
    const response = await postWithLlmConfig(
      '/api/py/extract-book-reduce',
      { novelName: novel?.name ?? '', mapSummaries },
      { signal }
    );
    if (!response.ok) {
      throw new Error(await readApiErrorMessage(response));
    }
    const dnaCard = (await response.json()) as NovelDNACard;
    await db.novels.update(novelId, { dnaCard, analysisStatus: 'done' });
  } catch (err) {
    if (signal.aborted) {
      await db.novels.update(novelId, { analysisStatus: 'idle' });
      return;
    }
    await db.novels.update(novelId, { analysisStatus: 'error' });
    throw err;
  }
}
