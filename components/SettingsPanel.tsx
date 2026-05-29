import React, { useState } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import { useAppStore } from '../app/store';
import { getProviderMeta, listProviderMetas } from '../app/llmProviders';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const { llmConfig, setActiveProvider, updateActiveProviderProfile } = useAppStore();
  const activeProvider = llmConfig.activeProvider;
  const activeProviderMeta = getProviderMeta(activeProvider);
  const activeProfile = llmConfig.providerProfiles[activeProvider];
  const providerOptions = listProviderMetas();

  const [showKey, setShowKey] = useState(false);

  if (!isOpen) return null;

  const requiresApiKey = activeProviderMeta.requiresApiKey;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-label="关闭设置"
      />

      <aside className="relative h-full w-full max-w-sm bg-[#08080a] border-l border-zinc-800 shadow-2xl flex flex-col animate-slide-in font-sans">
        {/* Header */}
        <header className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">大模型配置</h2>
            <p className="text-xs text-zinc-500 mt-0.5">密钥仅保存在本地浏览器</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded border border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900 transition-linear active-press"
            aria-label="关闭"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {/* Provider */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">提供商</label>
            <select
              value={activeProvider}
              onChange={(event) => setActiveProvider(event.target.value as typeof activeProvider)}
              className="w-full h-9 px-3 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 focus:outline-none focus:border-zinc-700 transition-linear cursor-pointer"
            >
              {providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id} className="bg-[#121214]">
                  {provider.name}
                </option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={activeProfile.apiKey}
                onChange={(event) => updateActiveProviderProfile({ apiKey: event.target.value })}
                onBlur={(event) => updateActiveProviderProfile({ apiKey: event.target.value.trim() })}
                placeholder={requiresApiKey ? 'sk-...' : '本地模型可不填'}
                className="w-full h-9 px-3 pr-10 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 transition-linear"
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                className="absolute right-2 top-1.5 h-6 w-6 inline-flex items-center justify-center text-zinc-500 hover:text-zinc-300 active-press transition-linear"
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Base URL */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">API Base URL</label>
            <input
              type="text"
              value={activeProfile.baseUrl}
              onChange={(event) => updateActiveProviderProfile({ baseUrl: event.target.value })}
              onBlur={(event) => updateActiveProviderProfile({ baseUrl: event.target.value.trim() })}
              placeholder="https://api.openai.com/v1"
              className="w-full h-9 px-3 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 transition-linear"
            />
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">模型</label>
            <input
              list="model-presets"
              value={activeProfile.model}
              onChange={(event) => updateActiveProviderProfile({ model: event.target.value })}
              onBlur={(event) => updateActiveProviderProfile({ model: event.target.value.trim() })}
              placeholder="例如 gpt-4o"
              className="w-full h-9 px-3 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 transition-linear"
            />
            <datalist id="model-presets">
              {activeProviderMeta.modelPresets.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </datalist>
          </div>
        </div>

        {/* Footer */}
        <footer className="px-5 py-4 border-t border-zinc-800 shrink-0">
          <button
            onClick={onClose}
            className="w-full h-9 rounded bg-zinc-100 hover:bg-zinc-200 text-zinc-950 text-xs font-bold transition-linear active-press"
          >
            完成
          </button>
        </footer>
      </aside>
    </div>
  );
}
