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
