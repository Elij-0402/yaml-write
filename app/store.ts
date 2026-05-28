import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface LLMConfig {
  provider: 'openai' | 'deepseek' | 'gemini' | 'siliconflow' | 'ollama' | 'custom';
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  providers: Record<string, ProviderConfig>;
}

const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  siliconflow: { apiKey: '', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  ollama: { apiKey: '', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
  custom: { apiKey: '', baseUrl: '', model: '' },
};

interface AppState {
  llmConfig: LLMConfig;
  activeTab: string; // 'upload' | 'contrast' | 'fusion'
  selectedNovelId: string | null;
  selectedChapterId: string | null;
  setLlmConfig: (config: Partial<LLMConfig>) => void;
  setActiveTab: (tab: string) => void;
  setSelectedNovelId: (id: string | null) => void;
  setSelectedChapterId: (id: string | null) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      llmConfig: {
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        temperature: 0.7,
        providers: DEFAULT_PROVIDERS,
      },
      activeTab: 'upload', // 'upload' | 'contrast' | 'fusion'
      selectedNovelId: null,
      selectedChapterId: null,
      setLlmConfig: (config) =>
        set((state) => {
          const updatedConfig = { ...state.llmConfig, ...config };

          // 如果切换了提供商，则自动载入目标提供商的配置
          if (config.provider && config.provider !== state.llmConfig.provider) {
            const nextProv = updatedConfig.providers[config.provider] || { apiKey: '', baseUrl: '', model: '' };
            updatedConfig.apiKey = nextProv.apiKey;
            updatedConfig.baseUrl = nextProv.baseUrl;
            updatedConfig.model = nextProv.model;
          } else {
            // 如果是编辑当前配置字段，则静默同步回当前提供商的缓存
            const curProv = updatedConfig.provider || 'custom';
            updatedConfig.providers = {
              ...updatedConfig.providers,
              [curProv]: {
                apiKey: updatedConfig.apiKey,
                baseUrl: updatedConfig.baseUrl,
                model: updatedConfig.model,
              },
            };
          }

          return { llmConfig: updatedConfig };
        }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setSelectedNovelId: (id) => set({ selectedNovelId: id, selectedChapterId: null }),
      setSelectedChapterId: (id) => set({ selectedChapterId: id }),
    }),
    {
      name: 'novel-fusion-store', // name of the item in the storage (must be unique)
    }
  )
);
