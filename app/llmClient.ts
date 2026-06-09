import { getProviderMeta, type ProviderId, type ProviderProfile } from './llmProviders';
import { useAppStore, type LLMConfig } from './store';

export interface ActiveLlmRuntimeConfig {
  provider: ProviderId;
  profile: ProviderProfile;
  temperature: number;
  requiresApiKey: boolean;
}

export interface LlmConfigReadiness {
  ok: boolean;
  message?: string;
}

function normalizeConfig(config?: LLMConfig): LLMConfig {
  return config ?? useAppStore.getState().llmConfig;
}

export function getActiveLlmRuntimeConfig(config?: LLMConfig): ActiveLlmRuntimeConfig {
  const llmConfig = normalizeConfig(config);
  const provider = llmConfig.activeProvider;
  const profile = llmConfig.providerProfiles[provider];
  const providerMeta = getProviderMeta(provider);
  return {
    provider,
    profile,
    temperature: llmConfig.temperature,
    requiresApiKey: providerMeta.requiresApiKey,
  };
}

export function getLlmConfigError(config?: LLMConfig): string | null {
  const runtimeConfig = getActiveLlmRuntimeConfig(config);
  const apiKey = runtimeConfig.profile.apiKey.trim();
  const baseUrl = runtimeConfig.profile.baseUrl.trim();
  const model = runtimeConfig.profile.model.trim();

  if (runtimeConfig.requiresApiKey && !apiKey) {
    return '请先配置 API Key。';
  }
  if (!baseUrl) {
    return '请先配置 API Base URL。';
  }
  if (!model) {
    return '请先配置模型名称。';
  }
  return null;
}

export function ensureLlmConfigReady(config?: LLMConfig): LlmConfigReadiness {
  const error = getLlmConfigError(config);
  if (error) return { ok: false, message: error };
  return { ok: true };
}

type LlmPayloadOptions = {
  includeTemperature?: boolean;
  config?: LLMConfig;
};

export function withLlmPayload<T extends Record<string, unknown>>(
  payload: T,
  options?: LlmPayloadOptions
): T & { apiKey: string; baseUrl: string; model: string; temperature?: number } {
  const runtimeConfig = getActiveLlmRuntimeConfig(options?.config);
  const apiKey = runtimeConfig.profile.apiKey || (runtimeConfig.requiresApiKey ? '' : 'local-llm');
  const enrichedPayload: T & { apiKey: string; baseUrl: string; model: string; temperature?: number } = {
    ...payload,
    apiKey,
    baseUrl: runtimeConfig.profile.baseUrl,
    model: runtimeConfig.profile.model,
  };
  if (options?.includeTemperature !== false) {
    enrichedPayload.temperature = runtimeConfig.temperature;
  }
  return enrichedPayload;
}

type LlmPostInit = {
  signal?: AbortSignal;
  includeTemperature?: boolean;
  config?: LLMConfig;
};

export async function postWithLlmConfig<T extends Record<string, unknown>>(
  endpoint: string,
  payload: T,
  init?: LlmPostInit
): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal: init?.signal,
    body: JSON.stringify(
      withLlmPayload(payload, {
        includeTemperature: init?.includeTemperature,
        config: init?.config,
      })
    ),
  });
}

export async function readApiErrorMessage(response: Response, fallback = '接口请求失败'): Promise<string> {
  const statusText = `HTTP ${response.status}`;
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string };
      detail?: string;
      message?: string;
    };
    return parsed.error?.message || parsed.message || parsed.detail || `${statusText} ${fallback}`;
  } catch {
    const trimmed = raw.trim();
    if (!trimmed) return `${statusText} ${fallback}`;
    return `${statusText} ${trimmed.slice(0, 120)}`;
  }
}

// 模块内哨兵错误：让调用方把 429 与普通错误 / abort 严格区分（严禁 any / 字符串判型）。
// 由 callStructured 命中 429 时抛出，dnaEngine.withRateLimitRetry 据 instanceof 静默退避重排。
export class RateLimitSignal extends Error {
  constructor() {
    super('rate_limited');
    this.name = 'RateLimitSignal';
  }
}

// 瞬时服务端错误（5xx / 代理超时）哨兵，与致命错误（配置 / 模型能力错）区分。
// callStructured 命中可重试 5xx 时抛出，dnaEngine.withRateLimitRetry 据 instanceof 静默退避重排。
export class TransientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'TransientError';
    this.status = status;
  }
}

// 可重试的瞬时状态码：5xx 与代理超时。422（结构化输出不合规）后端已重试耗尽，前端视为致命
// （交由预检 fail-fast 明确提示换模型），不在此列。
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

type StructuredInit<TResponse> = LlmPostInit & {
  // 默认 true：429 抛 RateLimitSignal 交给 withRateLimitRetry 静默退避；置 false 则把 429 当普通错误透出友好文案。
  rateLimitSignal?: boolean;
  // 可选运行时校验适配器（dnaSchema.parseX）：过网络的结构化返回不再裸 as T，坏 JSON 立即抛友好错误；缺省退回 as T。
  parse?: (json: unknown) => TResponse;
};

/**
 * POST 一个结构化（instructor）端点并取回其 JSON。吸收各调用点重复的三段样板：
 *   429 → RateLimitSignal（除非 rateLimitSignal:false）；!ok → readApiErrorMessage 抛错；否则 parse(json) 或 (json as T)。
 * 429 退避仍由调用方按需包在 withRateLimitRetry 内（行为不变）。
 */
export async function callStructured<TResponse>(
  endpoint: string,
  payload: Record<string, unknown>,
  init?: StructuredInit<TResponse>
): Promise<TResponse> {
  const response = await postWithLlmConfig(endpoint, payload, init);
  if (init?.rateLimitSignal !== false && response.status === 429) {
    throw new RateLimitSignal();
  }
  if (!response.ok) {
    const message = await readApiErrorMessage(response);
    // 5xx / 代理超时 → 可重试瞬时错误，交 withRateLimitRetry 静默退避重排；
    // 其余（400/401/403/404/413/422 等配置或模型能力错）→ 致命错误，立即上抛、不重试。
    if (isTransientStatus(response.status)) {
      throw new TransientError(message, response.status);
    }
    throw new Error(message);
  }
  const json: unknown = await response.json();
  return init?.parse ? init.parse(json) : (json as TResponse);
}

// === Shared SSE streaming consumer (event: delta|done|error frames from sse_event) ===
interface SseEventPayload {
  text?: string;
  code?: string;
  message?: string;
  ok?: boolean;
  [key: string]: unknown;
}

export function parseSseBuffer(buffer: string): { events: { event: string; payload: SseEventPayload }[]; rest: string } {
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  const events: { event: string; payload: SseEventPayload }[] = [];

  for (const rawChunk of chunks) {
    const lines = rawChunk.split('\n');
    let event = 'message';
    let dataLine = '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLine += line.slice(5).trim();
      }
    }
    if (!dataLine) continue;
    try {
      events.push({ event, payload: JSON.parse(dataLine) as SseEventPayload });
    } catch {
      events.push({ event: 'error', payload: { code: 'invalid_stream_payload', message: '流式返回格式异常。' } });
    }
  }

  return { events, rest };
}

export interface StreamSseHandlers {
  onDelta: (text: string) => void;
  onDone?: (payload: SseEventPayload) => void;
  signal?: AbortSignal;
}

export class StreamSseError extends Error {
  code: string;
  resumable: boolean;

  constructor(message: string, code: string, resumable: boolean) {
    super(message);
    this.name = 'StreamSseError';
    this.code = code;
    this.resumable = resumable;
  }
}

/**
 * POST to a streaming endpoint and dispatch each `delta` text chunk to onDelta.
 * Throws on a non-ok response, an `error` frame, or a stream that ends with no output.
 */
export async function streamSse<T extends Record<string, unknown>>(
  endpoint: string,
  payload: T,
  handlers: StreamSseHandlers
): Promise<void> {
  const response = await postWithLlmConfig(endpoint, payload, { signal: handlers.signal });
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response));
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('未获取到流读取器');
  }

  const decoder = new TextDecoder('utf-8');
  let done = false;
  let buffer = '';
  let gotDoneEvent = false;
  let receivedDelta = false;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    if (!value) continue;

    buffer += decoder.decode(value, { stream: !done });
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.rest;

    for (const event of parsed.events) {
      if (event.event === 'delta' && event.payload.text) {
        receivedDelta = true;
        handlers.onDelta(event.payload.text);
      } else if (event.event === 'error') {
        throw new StreamSseError(
          event.payload.message || '流式生成失败',
          event.payload.code || 'stream_error',
          receivedDelta
        );
      } else if (event.event === 'done') {
        gotDoneEvent = true;
        handlers.onDone?.(event.payload);
      }
    }
  }

  if (!gotDoneEvent) {
    if (receivedDelta) {
      throw new StreamSseError('流式连接中断，可继续接写。', 'stream_ended_without_done', true);
    }
    throw new StreamSseError('生成提前结束，请重试。', 'stream_ended_early', false);
  }
}
