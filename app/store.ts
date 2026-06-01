import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  createDefaultProviderProfiles,
  isProviderId,
  type ProviderId,
  type ProviderProfile,
} from './llmProviders';

const STORE_VERSION = 3;
const DEFAULT_TEMPERATURE = 0.7;

function xorEncryptDecrypt(input: string): string {
  const key = 'dna_crystal_key_mask_99';
  let output = '';
  for (let i = 0; i < input.length; i++) {
    output += String.fromCharCode(input.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return output;
}

// Sentinel marking an obfuscated key at rest. Lets us distinguish ciphertext
// from legacy plaintext on read (so migration is lossless and verifiable).
const KEY_CIPHER_PREFIX = 'x1:';

export function encryptKey(key: string): string {
  if (!key) return '';
  try {
    // Convert UTF-8 string to a safe 8-bit representation to prevent btoa crash on non-ASCII characters
    const latin1 = unescape(encodeURIComponent(key));
    const xored = xorEncryptDecrypt(latin1);
    const b64 = typeof btoa !== 'undefined'
      ? btoa(xored)
      : Buffer.from(xored, 'binary').toString('base64');
    return KEY_CIPHER_PREFIX + b64;
  } catch {
    return key;
  }
}

export function decryptKey(encrypted: string): string {
  if (!encrypted) return '';
  if (!encrypted.startsWith(KEY_CIPHER_PREFIX)) return encrypted; // legacy plaintext — leave as-is
  const b64 = encrypted.slice(KEY_CIPHER_PREFIX.length);
  try {
    const raw = typeof atob !== 'undefined'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
    const xored = xorEncryptDecrypt(raw);
    try {
      // New format: undo the UTF-8 → 8-bit wrap applied by encryptKey
      return decodeURIComponent(escape(xored));
    } catch {
      // Legacy keys stored before the UTF-8 wrap: the raw XOR result IS the key
      return xored;
    }
  } catch {
    return encrypted;
  }
}

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
  selectedNovelId: string | null;
  workshopOpen: boolean; // creative fusion workshop view
  manageMode: boolean; // show NovelUploader (chapters + re-split) for the selected novel
  sequencingGear: 'safe' | 'balanced' | 'speed';
  setSequencingGear: (gear: 'safe' | 'balanced' | 'speed') => void;
  shouldReduceEarly: boolean;
  setShouldReduceEarly: (reduce: boolean) => void;
  rateLimited: boolean;
  setRateLimited: (limited: boolean) => void;
  resetSequencingState: () => void;
  setActiveProvider: (provider: ProviderId) => void;
  updateActiveProviderProfile: (patch: Partial<ProviderProfile>) => void;
  setSelectedNovelId: (id: string | null) => void;
  setWorkshopOpen: (open: boolean) => void;
  setManageMode: (on: boolean) => void;
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
      selectedNovelId: null,
      workshopOpen: false,
      manageMode: false,
      sequencingGear: 'balanced',
      shouldReduceEarly: false,
      rateLimited: false,
      setSequencingGear: (gear) => set({ sequencingGear: gear }),
      setShouldReduceEarly: (reduce) => set({ shouldReduceEarly: reduce }),
      setRateLimited: (limited) => set({ rateLimited: limited }),
      resetSequencingState: () => set({ shouldReduceEarly: false, rateLimited: false }),
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
      setSelectedNovelId: (id) => set({ selectedNovelId: id, workshopOpen: false, manageMode: false }),
      setWorkshopOpen: (open) => set({ workshopOpen: open }),
      setManageMode: (on) => set({ manageMode: on }),
    }),
    {
      name: 'novel-fusion-store', // name of the item in the storage (must be unique)
      version: STORE_VERSION,
      // AC2: obfuscate every `apiKey` on its way to localStorage and restore it on read.
      // In-memory state always holds the plaintext key, so llmClient.ts needs no changes.
      storage: createJSONStorage(() => localStorage, {
        replacer: (key, value) =>
          key === 'apiKey' && typeof value === 'string' && value ? encryptKey(value) : value,
        reviver: (key, value) =>
          key === 'apiKey' && typeof value === 'string' && value ? decryptKey(value) : value,
      }),
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState;
        const state = persistedState as Record<string, unknown>;
        const gear = state.sequencingGear;
        return {
          ...state,
          llmConfig: normalizeLLMConfig(state.llmConfig),
          selectedNovelId: typeof state.selectedNovelId === 'string' ? state.selectedNovelId : null,
          workshopOpen: false,
          manageMode: false,
          sequencingGear: (gear === 'safe' || gear === 'balanced' || gear === 'speed') ? gear : 'balanced',
          shouldReduceEarly: false,
          rateLimited: false,
        };
      },
    }
  )
);
