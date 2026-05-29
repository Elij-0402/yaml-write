import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createDefaultProviderProfiles,
  isProviderId,
  type ProviderId,
  type ProviderProfile,
} from './llmProviders';

const STORE_VERSION = 2;
const DEFAULT_TEMPERATURE = 0.7;

export interface LLMConfig {
  activeProvider: ProviderId;
  providerProfiles: Record<ProviderId, ProviderProfile>;
  temperature: number;
}

const DEFAULT_LLM_CONFIG: LLMConfig = {
  activeProvider: 'openai',
  providerProfiles: createDefaultProviderProfiles(),
  temperature: DEFAULT_TEMPERATURE,
};

interface AppState {
  llmConfig: LLMConfig;
  activeTab: string; // 'upload' | 'contrast' | 'fusion'
  selectedNovelId: string | null;
  selectedChapterId: string | null;
  setActiveProvider: (provider: ProviderId) => void;
  updateActiveProviderProfile: (patch: Partial<ProviderProfile>) => void;
  setActiveTab: (tab: string) => void;
  setSelectedNovelId: (id: string | null) => void;
  setSelectedChapterId: (id: string | null) => void;
}

function clampTemperature(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_TEMPERATURE;
  return Math.max(0, Math.min(1.5, numeric));
}

function normalizeProviderProfiles(rawProfiles: unknown): Record<ProviderId, ProviderProfile> {
  const defaults = createDefaultProviderProfiles();
  if (!rawProfiles || typeof rawProfiles !== 'object') {
    return defaults;
  }

  const candidate = rawProfiles as Record<string, unknown>;
  const normalized = { ...defaults };
  (Object.keys(defaults) as ProviderId[]).forEach((provider) => {
    const raw = candidate[provider];
    if (!raw || typeof raw !== 'object') return;
    const current = raw as Partial<ProviderProfile>;

    normalized[provider] = {
      apiKey: typeof current.apiKey === 'string' ? current.apiKey : defaults[provider].apiKey,
      baseUrl:
        typeof current.baseUrl === 'string' && current.baseUrl.trim().length > 0
          ? current.baseUrl
          : defaults[provider].baseUrl,
      model:
        typeof current.model === 'string' && current.model.trim().length > 0
          ? current.model
          : defaults[provider].model,
    };
  });

  return normalized;
}

function normalizeLLMConfig(raw: unknown): LLMConfig {
  const defaults = createDefaultProviderProfiles();
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_LLM_CONFIG, providerProfiles: defaults };
  }

  const llmRaw = raw as Record<string, unknown>;
  const hasNewShape = 'activeProvider' in llmRaw && 'providerProfiles' in llmRaw;
  if (hasNewShape) {
    return {
      activeProvider: isProviderId(llmRaw.activeProvider) ? llmRaw.activeProvider : 'openai',
      providerProfiles: normalizeProviderProfiles(llmRaw.providerProfiles),
      temperature: clampTemperature(llmRaw.temperature),
    };
  }

  // Legacy shape migration: provider + apiKey/baseUrl/model + providers cache.
  const activeProvider = isProviderId(llmRaw.provider) ? llmRaw.provider : 'openai';
  const providerProfiles = normalizeProviderProfiles(llmRaw.providers);
  providerProfiles[activeProvider] = {
    apiKey: typeof llmRaw.apiKey === 'string' ? llmRaw.apiKey : providerProfiles[activeProvider].apiKey,
    baseUrl:
      typeof llmRaw.baseUrl === 'string' && llmRaw.baseUrl.trim().length > 0
        ? llmRaw.baseUrl
        : providerProfiles[activeProvider].baseUrl,
    model:
      typeof llmRaw.model === 'string' && llmRaw.model.trim().length > 0
        ? llmRaw.model
        : providerProfiles[activeProvider].model,
  };

  return {
    activeProvider,
    providerProfiles,
    temperature: clampTemperature(llmRaw.temperature),
  };
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      llmConfig: DEFAULT_LLM_CONFIG,
      activeTab: 'upload', // 'upload' | 'contrast' | 'fusion'
      selectedNovelId: null,
      selectedChapterId: null,
      setActiveProvider: (provider) =>
        set((state) => {
          if (provider === state.llmConfig.activeProvider) return state;
          return {
            llmConfig: {
              ...state.llmConfig,
              activeProvider: provider,
            },
          };
        }),
      updateActiveProviderProfile: (patch) =>
        set((state) => {
          const provider = state.llmConfig.activeProvider;
          const prevProfile = state.llmConfig.providerProfiles[provider];
          const nextProfile: ProviderProfile = {
            apiKey: typeof patch.apiKey === 'string' ? patch.apiKey : prevProfile.apiKey,
            baseUrl: typeof patch.baseUrl === 'string' ? patch.baseUrl : prevProfile.baseUrl,
            model: typeof patch.model === 'string' ? patch.model : prevProfile.model,
          };
          return {
            llmConfig: {
              ...state.llmConfig,
              providerProfiles: {
                ...state.llmConfig.providerProfiles,
                [provider]: nextProfile,
              },
            },
          };
        }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setSelectedNovelId: (id) => set({ selectedNovelId: id, selectedChapterId: null }),
      setSelectedChapterId: (id) => set({ selectedChapterId: id }),
    }),
    {
      name: 'novel-fusion-store', // name of the item in the storage (must be unique)
      version: STORE_VERSION,
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState;
        const state = persistedState as {
          llmConfig?: unknown;
          activeTab?: unknown;
          selectedNovelId?: unknown;
          selectedChapterId?: unknown;
        };
        return {
          ...persistedState,
          llmConfig: normalizeLLMConfig(state.llmConfig),
        };
      },
    }
  )
);
