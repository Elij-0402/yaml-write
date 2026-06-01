import { db, type Chapter, type ChapterMapSummary, type NovelDNACard } from './db';
import { postWithLlmConfig, readApiErrorMessage } from './llmClient';
import { useAppStore } from './store';

// Resumable, concurrency-limited book-level DNA extraction (Map-Reduce).
// Map: one /extract-chapter-map call per chapter, persisted immediately so a
// refresh/crash never loses progress. Reduce: fold all map summaries into one
// NovelDNACard. Re-running skips chapters already mapStatus==='done'.

export type DnaProgressListener = (current: number, total: number) => void;

// === 前端 429 抖动指数退避护航 ===
// 后端 run_structured 已内置 429/502/503/504 退避（api/index.py:279-298），耗尽后透出
// 真实 HTTP 429（{error:{code:'rate_limited'}}，无 Retry-After / retryAfterSeconds）。
// 这里在前端再加一层「静默退避重排」：429 不计失败、不标 error，只把该单元推回重试，并点亮
// store.rateLimited 让双螺旋测序仪「限速变黄 0.2x 呼吸」护航，绝不中断队列。
const RL_BASE_MS = 1000; // 退避基数
const RL_JITTER = 0.5; // 抖动比例：delay = base · 2^n · (1 + random·0.5)
const RL_MAX_MS = 30_000; // 单次退避上限
const RL_MAX_ATTEMPTS = 5; // 同一单元最多退避次数；耗尽作为真实失败兜底（防活锁 / 防额度耗尽空转）

// 模块内哨兵错误：让调用方把 429 与普通错误 / abort 严格区分（严禁 any / 字符串判型）。
class RateLimitSignal extends Error {
  constructor() {
    super('rate_limited');
    this.name = 'RateLimitSignal';
  }
}

// 当前卡在 429 退避中的 worker 数。点亮规则：第一个进入退避时点亮，最后一个恢复才熄灯，
// 避免多 worker 并发退避时护航灯频闪。
let rateLimitWaiting = 0;

function enterRateLimitWait(): void {
  rateLimitWaiting += 1;
  if (rateLimitWaiting === 1) {
    useAppStore.getState().setRateLimited(true);
  }
}

function leaveRateLimitWait(): void {
  rateLimitWaiting = Math.max(0, rateLimitWaiting - 1);
  if (rateLimitWaiting === 0) {
    useAppStore.getState().setRateLimited(false);
  }
}

// 可被打断的退避 sleep：等待期间 signal 一旦 abort 立即解除（事件驱动 + 150ms 轮询兜底，
// 严禁裸 await sleep() 阻断手刹）。关键：Map 阶段传入 linkedSignal——「暂停」与「阶段汇总」
// 都会经既有订阅（L199-209：shouldReduceEarly → mappingAbortController.abort()）同步 abort 它，
// 故只观察 signal.aborted 即同时覆盖两类手刹；Reduce 阶段传入父 signal，仅「暂停」可中断退避，
// 从而保证 early-reduce 后的 Reduce 仍能穿越 429 续测（AC5）。
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<'ok' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve('ok');
    }, ms);
    const poll = setInterval(() => {
      if (signal.aborted) {
        cleanup();
        resolve('aborted');
      }
    }, 150);
    const onAbort = () => {
      cleanup();
      resolve('aborted');
    };
    function cleanup(): void {
      clearTimeout(timeout);
      clearInterval(poll);
      signal.removeEventListener('abort', onAbort);
    }
    signal.addEventListener('abort', onAbort);
  });
}

// 单一共享退避 helper（Map 与 Reduce 复用，勿重复造轮子）：捕获 RateLimitSignal → 点亮护航灯
// → 抖动指数退避 → 重试；退避被 abort 抢占则重抛哨兵，交由调用方既有 catch 走「回滚 pending」
// 路径（与基线 abort 语义一致，零回归）；退避次数耗尽抛友好终态错误，作为真实失败兜底。
async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: { signal: AbortSignal }
): Promise<T> {
  const { signal } = opts;
  let parked = false;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof RateLimitSignal)) {
          throw err; // 非 429：原样上抛，沿用既有 abort 回滚 / 失败标记逻辑
        }
        if (attempt >= RL_MAX_ATTEMPTS) {
          // 退避预算耗尽 → 作为真实失败兜底（调用方据此标 error / 计入 failures）
          throw new Error('云端持续繁忙，已自动退避重试多次仍未成功，请稍后再试或调低测序档速。');
        }
        if (!parked) {
          parked = true;
          enterRateLimitWait();
        }
        const delay = Math.min(RL_BASE_MS * 2 ** attempt * (1 + Math.random() * RL_JITTER), RL_MAX_MS);
        const outcome = await interruptibleSleep(delay, signal);
        if (outcome === 'aborted') {
          throw err; // 手刹抢占：重抛哨兵，调用方 catch 见 signal.aborted → 回滚 pending
        }
      }
    }
  } finally {
    if (parked) {
      leaveRateLimitWait();
    }
  }
}

async function mapOneChapter(chapter: Chapter, signal: AbortSignal): Promise<void> {
  const response = await postWithLlmConfig(
    '/api/py/extract-chapter-map',
    { title: chapter.name, content: chapter.content },
    { signal }
  );
  if (response.status === 429) {
    throw new RateLimitSignal(); // 交给 withRateLimitRetry 静默退避重排，绝不标失败
  }
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
          await withRateLimitRetry(() => mapOneChapter(chapter, linkedSignal), { signal: linkedSignal });
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
          // 429 频限已在 withRateLimitRetry 内静默退避重试；能落到这里的只有非 429 错误，
          // 或退避次数耗尽的兜底失败——此时才计入 failures 并标 error。
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
      const dnaCard = await withRateLimitRetry(async () => {
        const response = await postWithLlmConfig(
          '/api/py/extract-book-reduce',
          { novelName: novel?.name ?? '', mapSummaries },
          { signal }
        );
        if (response.status === 429) {
          throw new RateLimitSignal(); // Reduce 同样护航退避，保证端到端「测序绝不中断」
        }
        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response));
        }
        return (await response.json()) as NovelDNACard;
      }, { signal });
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
    // 每轮提取结束熄灭护航灯（resetSequencingState 复位 rateLimited）。退避计数 rateLimitWaiting
    // 由 withRateLimitRetry 的 enter/leave 平衡门自行归零——此处不再强制清零，以免跨轮重叠运行时
    // 误清另一轮仍在退避的 worker 计数、令护航灯失同步。
    useAppStore.getState().resetSequencingState();
  }
}
