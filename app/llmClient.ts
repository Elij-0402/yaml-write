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

// === Shared SSE streaming consumer (event: delta|done|error frames from sse_event) ===
interface SseEventPayload {
  text?: string;
  code?: string;
  message?: string;
  ok?: boolean;
  [key: string]: unknown;
}

function parseSseBuffer(buffer: string): { events: { event: string; payload: SseEventPayload }[]; rest: string } {
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
        throw new Error(event.payload.message || '流式生成失败');
      } else if (event.event === 'done') {
        gotDoneEvent = true;
        handlers.onDone?.(event.payload);
      }
    }
  }

  if (!gotDoneEvent && !receivedDelta) {
    throw new Error('生成提前结束，请重试。');
  }
}
