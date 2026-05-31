import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
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
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-label="关闭"
      />

      <aside className="animate-slide-in relative flex h-full w-full max-w-md flex-col border-l border-subtle bg-panel">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-subtle px-6 py-4">
          <h2 className="text-lg font-medium">模型配置</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted transition-base hover:text-primary"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Status */}
          <div className={`rounded-lg border p-4 ${readiness ? 'border-amber-900/30 bg-amber-950/10' : 'border-emerald-900/30 bg-emerald-950/10'}`}>
            <div className="flex items-center gap-3">
              <span className={`h-2 w-2 rounded-full ${readiness ? 'bg-amber-500' : 'bg-emerald-500'}`} />
              <span className="text-sm font-medium">
                {readiness ? '配置未完成' : '配置完成'}
              </span>
            </div>
            {readiness && <p className="mt-2 text-xs text-secondary">{readiness}</p>}
            {returnHint && (
              <p className="mt-2 text-xs text-muted">待执行任务：{returnHint}</p>
            )}
          </div>

          {/* Form */}
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs text-muted">提供商</label>
              <select
                value={activeProvider}
                onChange={(e) => setActiveProvider(e.target.value as typeof activeProvider)}
                className="w-full rounded-md border border-subtle bg-card px-3 py-2.5 text-sm focus:outline-none focus:border-visible"
              >
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-muted">
                {requiresApiKey ? 'API Key' : '本地密钥（可留空）'}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={activeProfile.apiKey}
                  onChange={(e) => updateActiveProviderProfile({ apiKey: e.target.value })}
                  onBlur={(e) => updateActiveProviderProfile({ apiKey: e.target.value.trim() })}
                  placeholder={requiresApiKey ? 'sk-...' : '可选'}
                  className="w-full rounded-md border border-subtle bg-card px-3 py-2.5 pr-10 text-sm font-mono focus:outline-none focus:border-visible"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted transition-base hover:text-primary"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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
                className="w-full rounded-md border border-subtle bg-card px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-visible"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs text-muted">模型名称</label>
              <input
                list="model-presets"
                value={activeProfile.model}
                onChange={(e) => updateActiveProviderProfile({ model: e.target.value })}
                onBlur={(e) => updateActiveProviderProfile({ model: e.target.value.trim() })}
                placeholder="gpt-4o / deepseek-chat"
                className="w-full rounded-md border border-subtle bg-card px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-visible"
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

          {/* Info */}
          <div className="rounded-lg border border-subtle p-4 text-xs text-secondary">
            <p className="font-medium text-primary">安全说明</p>
            <p className="mt-1">密钥仅存储在浏览器本地，不会上传至服务器。</p>
          </div>
        </div>

        {/* Footer */}
        <footer className="border-t border-subtle p-6">
          <button
            onClick={onClose}
            className={`w-full rounded-md py-2.5 text-sm font-medium transition-base ${
              readiness
                ? 'border border-subtle bg-card text-secondary hover:bg-card/80'
                : 'bg-white text-black hover:bg-white/90'
            }`}
          >
            {readiness ? '保存并关闭' : '完成配置'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
