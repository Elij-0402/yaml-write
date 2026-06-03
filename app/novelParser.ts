// 把 classic Web Worker（/workers/novel-parser-worker.js）一次性的「请求 → 进度 → 成功/失败」通信封成 Promise。
// parseNovelFile（上传切分）与 resplit（重切）共用同一套 Worker 创建 / 15s 看门狗 / onmessage 分发 / terminate / signal 中止，
// 消除 NovelUploader 里 processFile 与 doResplit 近乎逐字重复的 ~135 行 Worker 生命周期双写。
// 注：DB 落盘仍由组件负责（新建小说 vs 删后重建两路语义不同、且要触组件态），此模块只产出解析结果。

import type { SplitMeta, SplitStrategyId } from './db';

const WORKER_URL = '/workers/novel-parser-worker.js';
const WATCHDOG_MS = 15000;

// worker success 帧里的章节形状（落盘时组件再补 id / novelId / status 等）。
export interface ParsedChapter {
  chapterIndex: number;
  title: string;
  content: string;
  wordCount: number;
  contentSha256?: string;
}

// worker progress 帧（stage 为 worker 词汇，组件按需收窄为自身 UploadStage）。
export interface ParseProgress {
  stage: string;
  percent?: number;
}

// 上传切分结果（含净化文本 + 净化字数，供新建小说落盘）。
export interface ParseFileResult {
  chapters: ParsedChapter[];
  splitMeta: SplitMeta;
  cleanedText: string;
  purifiedCount: number;
}

// 重切结果（复用既有 sourceTextCleaned，不回传净化文本）。
export interface ResplitResult {
  chapters: ParsedChapter[];
  splitMeta: SplitMeta;
}

interface RunOptions {
  onProgress?: (progress: ParseProgress) => void;
  signal?: AbortSignal;
  timeoutMessage: string;
}

// 单一 Worker 生命周期驱动：postMessage → 收 progress（喂看门狗）/ success（resolve）/ error（reject）；
// onerror、看门狗超时、signal 中止 均 reject 并 terminate（中止抛 AbortError，供组件静默忽略）。
function runWorker<T>(message: unknown, options: RunOptions): Promise<T> {
  const { onProgress, signal, timeoutMessage } = options;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const worker = new Worker(WORKER_URL);
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    const cleanup = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    }
    const fail = (message: string) => finish(() => reject(new Error(message)));
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => fail(timeoutMessage), WATCHDOG_MS);
    };

    worker.onmessage = (e: MessageEvent) => {
      const { type, stage, percent, data, message } = e.data || {};
      if (type === 'progress') {
        armWatchdog(); // 心跳重置看门狗
        onProgress?.({ stage, percent });
      } else if (type === 'success') {
        finish(() => resolve(data as T));
      } else if (type === 'error') {
        fail(message || '解析失败');
      }
    };
    worker.onerror = () => fail('Web Worker 线程发生运行期异常');

    signal?.addEventListener('abort', onAbort);
    armWatchdog();
    worker.postMessage(message);
  });
}

export function parseNovelFile(
  file: File,
  opts: { onProgress?: (p: ParseProgress) => void; signal?: AbortSignal } = {},
): Promise<ParseFileResult> {
  return runWorker<ParseFileResult>(
    { file },
    { ...opts, timeoutMessage: '此文档编码极度神秘，请确保它是未加密的标准 TXT 格式' },
  );
}

export function resplit(
  cleanedText: string,
  strategyId: SplitStrategyId,
  opts: { onProgress?: (p: ParseProgress) => void; signal?: AbortSignal; customRegex?: string } = {},
): Promise<ResplitResult> {
  const { customRegex, ...rest } = opts;
  return runWorker<ResplitResult>(
    { cleanedText, strategyId, customRegex },
    { ...rest, timeoutMessage: '重分章操作超时，请检查正则是否存在回溯风险' },
  );
}
