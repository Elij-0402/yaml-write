import { db, type Chapter, type ChapterMapSummary, type NovelDNACard } from './db';
import { postWithLlmConfig, readApiErrorMessage } from './llmClient';
import { useAppStore } from './store';

// Resumable, concurrency-limited book-level DNA extraction (Map-Reduce).
// Map: one /extract-chapter-map call per chapter, persisted immediately so a
// refresh/crash never loses progress. Reduce: fold all map summaries into one
// NovelDNACard. Re-running skips chapters already mapStatus==='done'.

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
  await db.chapters.update(chapter.id, { mapStatus: 'done', mapSummary: summary, mapCompletedAt: Date.now(), errorMsg: undefined });
}

async function computeSha256(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function ensureIncrementalHashes(
  novelId: string,
  opts: { onlyChapterId?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const { onlyChapterId, signal } = opts;
  const chapters = await db.chapters.where('novelId').equals(novelId).toArray();
  for (const c of chapters) {
    if (signal?.aborted) return;
    // Single-chapter 精测 only self-heals the target chapter, so other done
    // chapters keep their cached summaries for the Reduce phase (AC3).
    if (onlyChapterId && c.id !== onlyChapterId) continue;
    const currentSha = c.contentSha256;
    const computedSha = await computeSha256(c.content);
    if (!currentSha || currentSha !== computedSha) {
      await db.chapters.update(c.id, {
        contentSha256: computedSha,
        mapStatus: 'pending'
      });
    }
  }
}

/**
 * Extract (or resume extracting) the book-level DNA for a novel.
 * @param limit  cap the scope to the first N chapters (e.g. 100); omit for全量.
 */
export async function runDnaExtraction(
  novelId: string,
  opts: { limit?: number; targetChapterId?: string; signal: AbortSignal }
): Promise<void> {
  const { limit, targetChapterId, signal } = opts;

  try {
    await ensureIncrementalHashes(novelId, { onlyChapterId: targetChapterId, signal });

    const all = await db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex');
    const scope = typeof limit === 'number' ? all.slice(0, limit) : all;
    if (scope.length === 0) {
      await db.novels.update(novelId, { analysisStatus: 'error' });
      throw new Error('该小说还没有切分出章节，请先切分。');
    }

    let targets: Chapter[] = [];
    if (targetChapterId) {
      const targetCh = scope.find((c) => c.id === targetChapterId);
      if (!targetCh) {
        throw new Error('未找到指定章节。');
      }
      if (targetCh.wordCount > 30000) {
        throw new Error('本章字数已超过 30,000 字上限，为了保护大模型上下文及本地 IndexedDB 性能，请先用剪刀裁剪成小章。');
      }
      targets = [targetCh];
    } else {
      const overlimitChapters = scope.filter((c) => c.wordCount > 30000);
      if (overlimitChapters.length > 0) {
        throw new Error(`章节「${overlimitChapters[0].name}」字数已超过 30,000 字上限，为了保护大模型上下文及本地 IndexedDB 性能，请先用剪刀裁剪成小章。`);
      }
      targets = scope.filter((c) => c.mapStatus !== 'done');
    }

    const doneCount = scope.filter((c) => c.mapStatus === 'done').length;
    // Single-chapter 精测 reports progress for just the targeted chapter, not the whole scope.
    const progressTotal = targetChapterId ? targets.length : scope.length;
    const progressBase = targetChapterId ? 0 : doneCount;
    await db.novels.update(novelId, {
      analysisStatus: 'mapping',
      mapProgress: { total: progressTotal, current: progressBase },
    });
    
    // Linked abort controller for the mapping phase to support immediate soft-abort on early reduce
    const mappingAbortController = new AbortController();
    const linkedSignal = mappingAbortController.signal;
    
    const onParentAbort = () => {
      mappingAbortController.abort();
    };
    if (signal) {
      signal.addEventListener('abort', onParentAbort);
    }
    
    let activeWorkers = 0;
    let nextIndex = 0;
    let completed = progressBase;
    let failures = 0;

    const getConcurrencyLimit = () => {
      const gear = useAppStore.getState().sequencingGear || 'balanced';
      if (gear === 'safe') return 1;
      if (gear === 'speed') return 8;
      return 3;
    };

    let resolveMapPhase: (() => void) | null = null;
    const mapPhasePromise = new Promise<void>((resolve) => {
      resolveMapPhase = resolve;
    });

    const checkFinished = () => {
      if (activeWorkers === 0 && (nextIndex >= targets.length || linkedSignal.aborted || useAppStore.getState().shouldReduceEarly)) {
        resolveMapPhase?.();
      }
    };

    const runWorker = async () => {
      while (!linkedSignal.aborted) {
        if (useAppStore.getState().shouldReduceEarly) {
          activeWorkers--;
          checkFinished();
          return;
        }

        const currentLimit = getConcurrencyLimit();
        if (activeWorkers > currentLimit) {
          activeWorkers--;
          checkFinished();
          return;
        }

        const i = nextIndex++;
        if (i >= targets.length) {
          activeWorkers--;
          checkFinished();
          return;
        }

        const chapter = targets[i];
        try {
          await db.chapters.update(chapter.id, { mapStatus: 'mapping' });
          await mapOneChapter(chapter, linkedSignal);
          // O(1) atomic increment instead of re-querying + sorting every chapter per completion
          completed += 1;
          await db.novels.update(novelId, { mapProgress: { total: progressTotal, current: completed } });
        } catch (err) {
          if (linkedSignal.aborted) {
            // Roll back the in-flight chapter so it isn't left stuck in 'mapping'
            // (covers both plain pause and early-reduce); it re-analyzes next run.
            await db.chapters.update(chapter.id, { mapStatus: 'pending' });
            activeWorkers--;
            checkFinished();
            return;
          }
          failures += 1;
          await db.chapters.update(chapter.id, {
            mapStatus: 'error',
            errorMsg: err instanceof Error ? err.message : String(err),
          });
        }

        spawnWorkersIfNeeded();
      }
      activeWorkers--;
      checkFinished();
    };

    const spawnWorkersIfNeeded = () => {
      const currentLimit = getConcurrencyLimit();
      while (activeWorkers < currentLimit && nextIndex < targets.length && !linkedSignal.aborted && !useAppStore.getState().shouldReduceEarly) {
        activeWorkers++;
        runWorker();
      }
      checkFinished();
    };

    // Subscribe to Zustand store changes to dynamically adjust concurrency & stage summary
    let lastGear = useAppStore.getState().sequencingGear;
    let lastReduce = useAppStore.getState().shouldReduceEarly;

    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.sequencingGear !== lastGear || state.shouldReduceEarly !== lastReduce) {
        lastGear = state.sequencingGear;
        lastReduce = state.shouldReduceEarly;
        if (state.shouldReduceEarly) {
          mappingAbortController.abort();
        } else {
          spawnWorkersIfNeeded();
        }
      }
    });

    let isReduceEarly = false;
    try {
      spawnWorkersIfNeeded();
      await mapPhasePromise;
      isReduceEarly = useAppStore.getState().shouldReduceEarly;
    } finally {
      unsubscribe();
      if (signal) {
        signal.removeEventListener('abort', onParentAbort);
      }
    }

    if (signal.aborted) {
      await db.novels.update(novelId, { analysisStatus: 'idle' });
      return;
    }

    if (failures > 0 && !isReduceEarly) {
      await db.novels.update(novelId, { analysisStatus: 'error' });
      throw new Error(`有 ${failures} 个章节解析失败，请点击继续提取重试失败章节。`);
    }

    // --- Reduce phase ---
    await db.novels.update(novelId, { analysisStatus: 'reducing' });
    const novel = await db.novels.get(novelId);
    const mapped = await db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex');
    
    // Fold summaries for completed chapters
    const mapSummaries = mapped
      .filter((c) => (typeof limit === 'number' ? c.chapterIndex < limit : true) && c.mapStatus === 'done' && c.mapSummary)
      .map((c) => c.mapSummary as ChapterMapSummary);

    if (mapSummaries.length === 0) {
      await db.novels.update(novelId, { analysisStatus: 'error' });
      throw new Error('没有已成功测序的章节，无法进行阶段汇总。请至少等待一个章节测序完成。');
    }

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
  } finally {
    useAppStore.getState().resetSequencingState();
  }
}
