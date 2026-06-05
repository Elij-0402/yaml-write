import { db, type Chapter } from './db';
import { type ChapterMapSummary, type NovelDNACard, parseChapterMapSummary, parseNovelDNACard } from './dnaSchema';
import { selectResumeTargets, planReconcile } from './dnaState';
import { RateLimitSignal, TransientError, callStructured } from './llmClient';
import { useAppStore } from './store';
import {
  routeBySize,
  planExtractionUnits,
  ARC_WINDOW_BUDGET_CHARS,
  SAMPLE_WINDOW_CAP,
  type ExtractionUnit,
} from './dnaRouting';

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

// 模块内哨兵错误已上移至 llmClient.callStructured（避免 llmClient → dnaEngine 循环依赖）；此处仅 import 供 withRateLimitRetry 判型。

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
// 严禁裸 await sleep() 阻断手刹）。Map 阶段传入 linkedSignal（镜像父 signal 的「暂停」），
// 故只观察 signal.aborted 即覆盖暂停；Reduce 阶段传入父 signal，「暂停」可中断退避。
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

// 单一共享退避 helper（Map / Reduce / 融合工坊复用，勿重复造轮子）：捕获 RateLimitSignal（429）
// 与 TransientError（5xx / 代理超时）→ 点亮护航灯静默退避重排；致命错误（配置 / 模型能力错）原样上抛。
export async function withRateLimitRetry<T>(
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
        // RateLimitSignal（429）与 TransientError（5xx / 代理超时）均为瞬时错误，静默退避重排；
        // 其余（配置错 / 模型不支持结构化等致命错误）原样上抛，沿用既有 abort 回滚 / 失败标记逻辑。
        const retryable = err instanceof RateLimitSignal || err instanceof TransientError;
        if (!retryable) {
          throw err;
        }
        if (attempt >= RL_MAX_ATTEMPTS) {
          // 退避预算耗尽 → 作为真实失败兜底（调用方据此标 error / 计入 failures）。
          // TransientError 保留原始友好文案（含真实 HTTP 状态）；RateLimitSignal 给「云端繁忙」兜底。
          if (err instanceof TransientError) throw err;
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

const MAX_ARC_INPUT_CHARS = 48000;     // 与后端 ArcMapInput.content 上限一致
const MAX_DIRECT_INPUT_CHARS = 200000; // 与后端 BookDirectInput.content 上限一致

// 弧窗 map：把若干连续章节拼成弧文本 → 一条摘要；摘要落在 lead 章，其余成员标 done（不重复摘要，
// reduce 据 mapSummary 仅纳入 lead），让章节列表状态与覆盖一致、且续跑只看 lead 是否 done。
async function mapOneUnit(unit: ExtractionUnit, byId: Map<string, Chapter>, signal: AbortSignal): Promise<void> {
  const parts: string[] = [];
  for (const cid of unit.chapterIds) {
    const ch = byId.get(cid);
    if (ch && ch.content) parts.push(`【${ch.name}】\n${ch.content}`);
  }
  let content = parts.join('\n\n');
  if (content.length > MAX_ARC_INPUT_CHARS) {
    // 砍尾不静默（决策 C2）：仅超长单章自成一窗且 >48k 时触发；记录截断量，UI 经 oversizedChapter 警告引导先裁切。
    console.warn(`[dnaEngine] 弧窗「${unit.label}」原文 ${content.length} 字符超过单窗上限 ${MAX_ARC_INPUT_CHARS}，截断尾部 ${content.length - MAX_ARC_INPUT_CHARS} 字符（含超长单章，建议先到切分台裁切）。`);
    content = content.slice(0, MAX_ARC_INPUT_CHARS);
  }
  // callStructured 吸收 429→RateLimitSignal + !ok→错误 + json 取值；parse 做运行时校验；外层 withRateLimitRetry 负责静默退避重排。
  const summary = await callStructured<ChapterMapSummary>(
    '/api/py/extract-arc-map',
    { title: unit.label, content },
    { signal, parse: parseChapterMapSummary }
  );
  await db.chapters.update(unit.id, { mapStatus: 'done', mapSummary: summary, mapCompletedAt: Date.now(), errorMsg: undefined });
  for (const cid of unit.chapterIds) {
    if (cid !== unit.id) {
      await db.chapters.update(cid, { mapStatus: 'done', errorMsg: undefined });
    }
  }
}

// 小档「整本直提」：整本净化文本一次喂入 → 4 层 DNA（跳过逐章 map / reduce）。
async function extractBookDirect(novelName: string, content: string, signal: AbortSignal): Promise<NovelDNACard> {
  let text = content;
  if (text.length > MAX_DIRECT_INPUT_CHARS) text = text.slice(0, MAX_DIRECT_INPUT_CHARS);
  return callStructured<NovelDNACard>(
    '/api/py/extract-book-direct',
    { novelName, content: text },
    { signal, parse: parseNovelDNACard }
  );
}

async function computeSha256(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// reconcile 落库（统一不变量的「后向一半」落地）：读 novel + chapters → planReconcile（纯决策）→
// 在单个 db.transaction 内应用复位计划（analysisStatus → idle，mapping 章节 → pending）。
// NovelDetail 挂载对账调用本函数，不再内联 db 写——前向（runDnaExtraction 的 resume）与后向（本函数）同住此 seam 后面。
// 非滞留态（idle/done/error，plan 为 null）直接返回，幂等安全。
export async function reconcileExtraction(novelId: string): Promise<void> {
  const novel = await db.novels.get(novelId);
  if (!novel) return;
  const chapters = await db.chapters.where('novelId').equals(novelId).toArray();
  const plan = planReconcile(novel, chapters);
  if (!plan) return;
  await db.transaction('rw', db.novels, db.chapters, async () => {
    await db.novels.update(novelId, { analysisStatus: plan.nextAnalysisStatus });
    if (plan.resetChapterIds.length > 0) {
      await db.chapters.where('id').anyOf(plan.resetChapterIds).modify({ mapStatus: 'pending' });
    }
  });
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
 * 零参数：按净化字数自动路由（小=整本直提 / 中=弧窗逐组 / 大=饱和采样）。可中断、可续跑、挂载自愈。
 */
export async function runDnaExtraction(
  novelId: string,
  opts: { signal: AbortSignal }
): Promise<void> {
  const { signal } = opts;

  try {
    const novel = await db.novels.get(novelId);
    if (!novel) {
      throw new Error('未找到该小说。');
    }

    const all = await db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex');
    if (all.length === 0) {
      await db.novels.update(novelId, { analysisStatus: 'error' });
      throw new Error('该小说还没有切分出章节，请先切分。');
    }

    const wordCount = novel.wordCount || novel.sourceTextCleaned?.length || all.reduce((s, c) => s + (c.wordCount || 0), 0);
    const route = routeBySize(wordCount);

    // —— 小档：整本直提（跳过逐章 map / reduce）——
    if (route === 'direct') {
      await db.novels.update(novelId, { analysisStatus: 'reducing', mapProgress: { total: 1, current: 0 } });
      const content = (novel.sourceTextCleaned && novel.sourceTextCleaned.trim())
        ? novel.sourceTextCleaned
        : all.map((c) => `【${c.name}】\n${c.content}`).join('\n\n');
      try {
        const dnaCard = await withRateLimitRetry(
          () => extractBookDirect(novel.name, content, signal),
          { signal }
        );
        if (signal.aborted) {
          await db.novels.update(novelId, { analysisStatus: 'idle' });
          return;
        }
        await db.novels.update(novelId, { dnaCard, dnaCardVersion: 2, analysisStatus: 'done', mapProgress: { total: 1, current: 1 } });
      } catch (err) {
        if (signal.aborted) {
          await db.novels.update(novelId, { analysisStatus: 'idle' });
          return;
        }
        await db.novels.update(novelId, { analysisStatus: 'error' });
        throw err;
      }
      return;
    }

    // —— 中/大档：弧窗逐组 map → reduce ——
    await ensureIncrementalHashes(novelId, { signal });
    const chaptersForPlan = await db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex');
    const byId = new Map(chaptersForPlan.map((c) => [c.id, c]));
    const units = planExtractionUnits(
      chaptersForPlan.map((c) => ({ id: c.id, name: c.name, wordCount: c.wordCount })),
      route,
      { budgetChars: ARC_WINDOW_BUDGET_CHARS, sampleCap: SAMPLE_WINDOW_CAP },
    );
    if (units.length === 0) {
      await db.novels.update(novelId, { analysisStatus: 'error' });
      throw new Error('未能规划出可提取的弧窗，请先确认章节切分正常。');
    }
    // 大档采样会跳过部分章节——明确告知覆盖范围（禁止静默截断）。
    if (route === 'sampling') {
      const covered = units.reduce((s, u) => s + u.chapterIds.length, 0);
      console.info(`[dnaEngine] 饱和采样：在 ${chaptersForPlan.length} 章中实测 ${units.length} 个弧窗（覆盖约 ${covered} 章），以避免上千章卡死。`);
    }

    // 续跑：仅测 lead 章未 done 的窗口（前向不变量，纯判定提至 dnaState.selectResumeTargets）。
    const targets = selectResumeTargets(units, byId);
    const doneUnits = units.length - targets.length;
    const progressTotal = units.length;

    await db.novels.update(novelId, {
      analysisStatus: 'mapping',
      mapProgress: { total: progressTotal, current: doneUnits },
    });

    // 链接 abort 控制器：父 signal「暂停」→ 同步 abort 本阶段所有在飞调用。
    const mappingAbortController = new AbortController();
    const linkedSignal = mappingAbortController.signal;
    const onParentAbort = () => mappingAbortController.abort();
    if (signal) signal.addEventListener('abort', onParentAbort);

    let activeWorkers = 0;
    let nextIndex = 0;
    let completed = doneUnits;
    let failures = 0;
    const CONCURRENCY = route === 'sampling' ? 6 : 3;

    let resolveMapPhase: (() => void) | null = null;
    const mapPhasePromise = new Promise<void>((resolve) => { resolveMapPhase = resolve; });

    const checkFinished = () => {
      if (activeWorkers === 0 && (nextIndex >= targets.length || linkedSignal.aborted)) {
        resolveMapPhase?.();
      }
    };

    const runWorker = async () => {
      while (!linkedSignal.aborted) {
        if (activeWorkers > CONCURRENCY) { activeWorkers--; checkFinished(); return; }
        const i = nextIndex++;
        if (i >= targets.length) { activeWorkers--; checkFinished(); return; }
        const unit = targets[i];
        try {
          await db.chapters.update(unit.id, { mapStatus: 'mapping' });
          await withRateLimitRetry(() => mapOneUnit(unit, byId, linkedSignal), { signal: linkedSignal });
          completed += 1;
          await db.novels.update(novelId, { mapProgress: { total: progressTotal, current: completed } });
        } catch (err) {
          if (linkedSignal.aborted) {
            // 回滚在飞窗口的 lead 至 pending，下轮可续跑。
            await db.chapters.update(unit.id, { mapStatus: 'pending' });
            activeWorkers--; checkFinished(); return;
          }
          // 429 已在 withRateLimitRetry 内静默退避；落到这里的是非 429 错误或退避耗尽兜底。
          failures += 1;
          await db.chapters.update(unit.id, {
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
      while (activeWorkers < CONCURRENCY && nextIndex < targets.length && !linkedSignal.aborted) {
        activeWorkers++;
        runWorker();
      }
      checkFinished();
    };

    try {
      // —— 预检探活（决策 C1，fail-fast）：并发铺开前先串行跑第一个目标窗。——
      // 「从来没成功过」「模型不支持结构化」等系统性故障会在这里秒级暴露，不再让其余窗白跑空耗额度。
      if (targets.length > 0) {
        const probe = targets[0];
        await db.chapters.update(probe.id, { mapStatus: 'mapping' });
        try {
          await withRateLimitRetry(() => mapOneUnit(probe, byId, linkedSignal), { signal: linkedSignal });
          completed += 1;
          nextIndex = 1; // 已消费 targets[0]，worker 池从 1 开始铺开
          await db.novels.update(novelId, { mapProgress: { total: progressTotal, current: completed } });
        } catch (err) {
          if (linkedSignal.aborted) {
            await db.chapters.update(probe.id, { mapStatus: 'pending' });
            await db.novels.update(novelId, { analysisStatus: 'idle' });
            return;
          }
          // 致命错误（瞬时 5xx/429 已被 withRateLimitRetry 退避吃掉，落到这里多为配置错 / 模型不支持结构化）：
          // 立即标 error 并写明确原因，绝不铺开其余窗白跑。
          const reason = err instanceof Error ? err.message : String(err);
          await db.chapters.update(probe.id, { mapStatus: 'error', errorMsg: reason });
          await db.novels.update(novelId, { analysisStatus: 'error' });
          throw new Error(`DNA 提取预检失败（首个弧窗未通过，已停止以免空跑）：${reason}`);
        }
      }
      spawnWorkersIfNeeded();
      await mapPhasePromise;
    } finally {
      if (signal) signal.removeEventListener('abort', onParentAbort);
    }

    if (signal.aborted) {
      await db.novels.update(novelId, { analysisStatus: 'idle' });
      return;
    }
    // 覆盖率阈值降级（决策 B2）：采样本是近似，不要求零失败。成功窗达到足够覆盖即继续归纳出卡，
    // 失败窗降级为「覆盖度提示」（仍各自保留 error 标记可后续单独补齐）；不足阈值才整体判失败。
    // arc / direct 维持全覆盖严格语义（minRequired = units.length）。
    const minRequired = route === 'sampling'
      ? Math.min(units.length, Math.max(2, Math.ceil(units.length * 0.6)))
      : units.length;
    if (completed < minRequired) {
      await db.novels.update(novelId, { analysisStatus: 'error' });
      throw new Error(`弧窗成功率不足（成功 ${completed}/${units.length}），无法稳定归纳 DNA，请点击继续提取重试或检查模型配置。`);
    }
    if (failures > 0) {
      console.info(`[dnaEngine] 部分弧窗失败（${failures}/${units.length}），成功 ${completed} 窗已达覆盖阈值 ${minRequired}，继续归纳 DNA；失败窗可后续单独补齐。`);
    }

    // —— Reduce：折叠所有 done 弧窗（lead）摘要 → 4 层 DNA ——
    await db.novels.update(novelId, { analysisStatus: 'reducing' });
    const mapped = await db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex');
    const mapSummaries = mapped
      .filter((c) => c.mapStatus === 'done' && c.mapSummary)
      .map((c) => c.mapSummary as ChapterMapSummary);
    if (mapSummaries.length === 0) {
      await db.novels.update(novelId, { analysisStatus: 'error' });
      throw new Error('没有已成功测序的弧窗，无法归纳 DNA。请稍后重试。');
    }

    try {
      const dnaCard = await withRateLimitRetry(
        () => callStructured<NovelDNACard>(
          '/api/py/extract-book-reduce',
          { novelName: novel.name, mapSummaries },
          { signal, parse: parseNovelDNACard }
        ),
        { signal }
      );
      await db.novels.update(novelId, { dnaCard, dnaCardVersion: 2, analysisStatus: 'done' });
    } catch (err) {
      if (signal.aborted) {
        await db.novels.update(novelId, { analysisStatus: 'idle' });
        return;
      }
      await db.novels.update(novelId, { analysisStatus: 'error' });
      throw err;
    }
  } finally {
    // 每轮提取结束熄灭护航灯。退避计数 rateLimitWaiting 由 withRateLimitRetry 的 enter/leave 平衡门
    // 自行归零——此处不强制清零，以免跨轮重叠运行时误清另一轮仍在退避的 worker 计数、令护航灯失同步。
    useAppStore.getState().setRateLimited(false);
  }
}
