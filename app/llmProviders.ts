export type ProviderId = 'openai' | 'deepseek' | 'gemini' | 'siliconflow' | 'ollama' | 'custom';

export interface ProviderProfile {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ProviderModelPreset {
  label: string;
  value: string;
}

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  shortName?: string;
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
  modelPresets: ProviderModelPreset[];
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderMeta> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    shortName: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    requiresApiKey: true,
    modelPresets: [
      { label: 'GPT-4o', value: 'gpt-4o' },
      { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
    ],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    shortName: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    requiresApiKey: true,
    modelPresets: [
      { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash' },
      { label: 'DeepSeek V4 Pro', value: 'deepseek-v4-pro' },
      { label: 'DeepSeek Chat（兼容旧版）', value: 'deepseek-chat' },
      { label: 'DeepSeek Reasoner（兼容旧版）', value: 'deepseek-reasoner' },
    ],
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    shortName: 'Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    requiresApiKey: true,
    modelPresets: [
      { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
      { label: 'Gemini 1.5 Flash', value: 'gemini-1.5-flash' },
      { label: 'Gemini 1.5 Pro', value: 'gemini-1.5-pro' },
    ],
  },
  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动',
    shortName: '硅基',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    requiresApiKey: true,
    modelPresets: [
      { label: 'DeepSeek V3 (硅基)', value: 'deepseek-ai/DeepSeek-V3' },
      { label: 'DeepSeek R1 (硅基)', value: 'deepseek-ai/DeepSeek-R1' },
      { label: 'Qwen 2.5 72B', value: 'Qwen/Qwen2.5-72B-Instruct' },
    ],
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama 本地',
    shortName: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    requiresApiKey: false,
    modelPresets: [
      { label: 'Llama 3 (8B)', value: 'llama3' },
      { label: 'Qwen 2.5 (7B)', value: 'qwen2.5' },
    ],
  },
  custom: {
    id: 'custom',
    name: '自定义中转',
    shortName: '自定义',
    defaultBaseUrl: '',
    defaultModel: '',
    requiresApiKey: true,
    modelPresets: [],
  },
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && Object.hasOwn(PROVIDER_REGISTRY, value);
}

export function getProviderMeta(providerId: ProviderId): ProviderMeta {
  return PROVIDER_REGISTRY[providerId];
}

export function listProviderMetas(): ProviderMeta[] {
  return Object.values(PROVIDER_REGISTRY);
}

export function createDefaultProviderProfiles(): Record<ProviderId, ProviderProfile> {
  return Object.values(PROVIDER_REGISTRY).reduce((acc, provider) => {
    acc[provider.id] = {
      apiKey: '',
      baseUrl: provider.defaultBaseUrl,
      model: provider.defaultModel,
    };
    return acc;
  }, {} as Record<ProviderId, ProviderProfile>);
}

export function normalizeLegacyProviderProfile(
  providerId: ProviderId,
  profile: ProviderProfile
): ProviderProfile {
  if (providerId !== 'deepseek') return profile;

  return {
    ...profile,
    baseUrl: profile.baseUrl === 'https://api.deepseek.com/v1' ? 'https://api.deepseek.com' : profile.baseUrl,
    model: profile.model === 'deepseek-chat' ? 'deepseek-v4-flash' : profile.model,
  };
}
