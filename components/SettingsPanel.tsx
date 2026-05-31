import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../app/store';
import { getProviderMeta, listProviderMetas } from '../app/llmProviders';
import { getLlmConfigError } from '../app/llmClient';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  returnHint?: string | null;
}

export default function SettingsPanel({ isOpen, onClose, returnHint }: SettingsPanelProps) {
  const { llmConfig, setActiveProvider, updateActiveProviderProfile } = useAppStore();
  const activeProvider = llmConfig.activeProvider;
  const activeProviderMeta = getProviderMeta(activeProvider);
  const activeProfile = llmConfig.providerProfiles[activeProvider];
  const providerOptions = listProviderMetas();
  const [showKey, setShowKey] = useState(false);

  const readiness = useMemo(() => getLlmConfigError(llmConfig), [llmConfig]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const requiresApiKey = activeProviderMeta.requiresApiKey;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="关闭" />

      <aside className="relative flex h-full w-full max-w-md flex-col border-l bg-black">
        <header className="flex h-12 items-center justify-between border-b px-6">
          <span className="text-sm">设置</span>
          <button onClick={onClose} className="text-secondary hover:text-primary">×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Status */}
          <div className="flex items-center gap-3 text-sm">
            <span className={readiness ? 'text-amber-500' : 'text-emerald-500'}>
              {readiness ? '○' : '●'}
            </span>
            <span>{readiness || '配置完成'}</span>
          </div>

          {returnHint && <p className="text-xs text-muted">待执行: {returnHint}</p>}

          {/* Form */}
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs text-muted">提供商</label>
              <select
                value={activeProvider}
                onChange={(e) => setActiveProvider(e.target.value as typeof activeProvider)}
                className="w-full border bg-transparent p-2 text-sm focus:outline-none"
              >
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-muted">{requiresApiKey ? 'API Key' : 'API Key（可选）'}</label>
              <div className="flex items-center gap-2">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={activeProfile.apiKey}
                  onChange={(e) => updateActiveProviderProfile({ apiKey: e.target.value })}
                  onBlur={(e) => updateActiveProviderProfile({ apiKey: e.target.value.trim() })}
                  placeholder="sk-..."
                  className="flex-1 border bg-transparent p-2 text-sm font-mono focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="text-xs text-muted hover:text-secondary"
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-muted">Base URL</label>
              <input
                type="text"
                value={activeProfile.baseUrl}
                onChange={(e) => updateActiveProviderProfile({ baseUrl: e.target.value })}
                onBlur={(e) => updateActiveProviderProfile({ baseUrl: e.target.value.trim() })}
                placeholder="https://api.example.com/v1"
                className="w-full border bg-transparent p-2 text-sm font-mono focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs text-muted">模型</label>
              <input
                list="model-presets"
                value={activeProfile.model}
                onChange={(e) => updateActiveProviderProfile({ model: e.target.value })}
                onBlur={(e) => updateActiveProviderProfile({ model: e.target.value.trim() })}
                placeholder="gpt-4o"
                className="w-full border bg-transparent p-2 text-sm font-mono focus:outline-none"
              />
              <datalist id="model-presets">
                {activeProviderMeta.modelPresets.map((preset) => (
                  <option key={preset.value} value={preset.value}>{preset.label}</option>
                ))}
              </datalist>
            </div>
          </div>

          <p className="text-xs text-muted">密钥仅存储在浏览器本地，不会上传服务器。</p>
        </div>

        <footer className="border-t p-6">
          <button onClick={onClose} className="w-full py-2 text-sm text-secondary hover:text-primary">
            关闭
          </button>
        </footer>
      </aside>
    </div>
  );
}
