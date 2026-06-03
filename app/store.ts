import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import {
  createDefaultProviderProfiles,
  isProviderId,
  normalizeLegacyProviderProfile,
  type ProviderId,
  type ProviderProfile,
} from './llmProviders';

const STORE_VERSION = 5;
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
    // 损坏密文（解密/解码失败）视为未配置，避免把乱码当成"已就绪"的 Key 发往后端。
    return '';
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
  activeCreationId: string | null; // 工坊当前读写的创作库记录 id（v8 多记录创作库）
  manageMode: boolean; // show NovelUploader (chapters + re-split) for the selected novel
  engineNovelId: string | null; // 配方台：指认为「骨架(引擎)」的书
  skinNovelId: string | null;   // 配方台：指认为「题材(皮)」的书
  rateLimited: boolean;
  setRateLimited: (limited: boolean) => void;
  workshopBusy: boolean; // 工坊流式/生成进行中——禁止 busy 时切换/新建创作，避免跨创作 stale-write
  setWorkshopBusy: (busy: boolean) => void;
  persistError: boolean;
  setPersistError: (value: boolean) => void;
  setActiveProvider: (provider: ProviderId) => void;
  updateActiveProviderProfile: (patch: Partial<ProviderProfile>) => void;
  setSelectedNovelId: (id: string | null) => void;
  setWorkshopOpen: (open: boolean) => void;
  setActiveCreationId: (id: string | null) => void;
  setManageMode: (on: boolean) => void;
  setEngineNovelId: (id: string | null) => void;
  setSkinNovelId: (id: string | null) => void;
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

    normalized[provider] = normalizeLegacyProviderProfile(provider, {
      apiKey: typeof current.apiKey === 'string' ? current.apiKey : defaults[provider].apiKey,
      baseUrl:
        typeof current.baseUrl === 'string' && current.baseUrl.trim().length > 0
          ? current.baseUrl
          : defaults[provider].baseUrl,
      model:
        typeof current.model === 'string' && current.model.trim().length > 0
          ? current.model
          : defaults[provider].model,
    });
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

// localStorage 包装：写失败（隐私模式 / 配额耗尽）不再静默吞掉，而是点亮 persistError 供顶栏提示。
const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try { return localStorage.getItem(name); } catch { return null; }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      try { useAppStore.getState().setPersistError(true); } catch { /* store not ready */ }
    }
  },
  removeItem: (name) => {
    try { localStorage.removeItem(name); } catch { /* ignore */ }
  },
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      llmConfig: DEFAULT_LLM_CONFIG,
      selectedNovelId: null,
      workshopOpen: false,
      activeCreationId: null,
      manageMode: false,
      engineNovelId: null,
      skinNovelId: null,
      rateLimited: false,
      workshopBusy: false,
      persistError: false,
      setRateLimited: (limited) => set({ rateLimited: limited }),
      setWorkshopBusy: (busy) => set({ workshopBusy: busy }),
      setPersistError: (value) => set({ persistError: value }),
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
      setSelectedNovelId: (id) => set({ selectedNovelId: id, workshopOpen: false, manageMode: false, activeCreationId: null }),
      setWorkshopOpen: (open) => set({ workshopOpen: open }),
      setActiveCreationId: (id) => set({ activeCreationId: id, workshopOpen: true, manageMode: false }),
      setManageMode: (on) => set({ manageMode: on }),
      setEngineNovelId: (id) => set({ engineNovelId: id }),
      setSkinNovelId: (id) => set({ skinNovelId: id }),
    }),
    {
      name: 'novel-fusion-store', // name of the item in the storage (must be unique)
      version: STORE_VERSION,
      // AC2: obfuscate every `apiKey` on its way to localStorage and restore it on read.
      // In-memory state always holds the plaintext key, so llmClient.ts needs no changes.
      storage: createJSONStorage(() => safeLocalStorage, {
        replacer: (key, value) =>
          key === 'apiKey' && typeof value === 'string' && value ? encryptKey(value) : value,
        reviver: (key, value) =>
          key === 'apiKey' && typeof value === 'string' && value ? decryptKey(value) : value,
      }),
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          try { useAppStore.getState().setPersistError(true); } catch { /* store not ready */ }
        }
      },
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState;
        const state = persistedState as Record<string, unknown>;
        // STORE_VERSION 5：继续清理已删状态字段，并让 providerProfiles 经过最新的默认值/兼容迁移。
        delete state.sequencingGear;
        delete state.shouldReduceEarly;
        delete state.fusionBias;
        return {
          ...state,
          llmConfig: normalizeLLMConfig(state.llmConfig),
          selectedNovelId: typeof state.selectedNovelId === 'string' ? state.selectedNovelId : null,
          workshopOpen: false,
          activeCreationId: null,
          manageMode: false,
          engineNovelId: null,
          skinNovelId: null,
          rateLimited: false,
          workshopBusy: false,
          persistError: false,
        };
      },
    }
  )
);
