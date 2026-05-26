import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
}

interface AppState {
  llmConfig: LLMConfig;
  activeTab: string;
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
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        temperature: 0.7,
      },
      activeTab: 'upload', // 'upload' | 'contrast' | 'fusion'
      selectedNovelId: null,
      selectedChapterId: null,
      setLlmConfig: (config) =>
        set((state) => ({
          llmConfig: { ...state.llmConfig, ...config },
        })),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setSelectedNovelId: (id) => set({ selectedNovelId: id, selectedChapterId: null }),
      setSelectedChapterId: (id) => set({ selectedChapterId: id }),
    }),
    {
      name: 'novel-fusion-store', // name of the item in the storage (must be unique)
    }
  )
);
