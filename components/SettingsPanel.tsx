import React, { useMemo, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, LockKeyhole, Orbit, X } from 'lucide-react';
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

  if (!isOpen) return null;

  const requiresApiKey = activeProviderMeta.requiresApiKey;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" className="absolute inset-0 bg-black/72 backdrop-blur-sm" onClick={onClose} aria-label="关闭设置" />

      <aside className="animate-slide-in relative flex h-full w-full max-w-[440px] flex-col border-l border-white/10 bg-[#070a10] shadow-2xl">
        <header className="linear-border-b px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs text-amber-100">
                <Orbit className="h-3.5 w-3.5" />
                工坊启动面板
              </div>
              <h2 className="mt-4 text-xl font-semibold text-zinc-50">先点亮模型引擎，再继续当前任务</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                密钥仅保存在本地浏览器。完成以下配置后，DNA 提取和融合变体阶段都会自动恢复到可继续状态。
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-full border border-white/10 p-2 text-zinc-500 transition-linear hover:border-white/20 hover:text-zinc-200"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className={`rounded-3xl border p-5 ${readiness ? 'border-amber-300/18 bg-amber-300/10' : 'border-emerald-300/18 bg-emerald-300/10'}`}>
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">当前状态</p>
            <h3 className={`mt-3 text-lg font-semibold ${readiness ? 'text-amber-50' : 'text-emerald-50'}`}>
              {readiness ? '还有配置项未完成' : '模型引擎已就绪'}
            </h3>
            <p className="mt-2 text-sm leading-6 text-zinc-300">
              {readiness ? readiness : '现在可以直接返回继续 DNA 提取或进入融合变体阶段。'}
            </p>
            {returnHint && (
              <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-zinc-300">
                配置完成后返回：<span className="text-zinc-100">{returnHint}</span>
              </div>
            )}
          </div>

          <div className="mt-5 grid gap-3">
            {[
              { label: '服务提供方', done: true },
              { label: requiresApiKey ? '密钥' : '本地服务密钥', done: !requiresApiKey || activeProfile.apiKey.trim().length > 0 },
              { label: '接口地址', done: activeProfile.baseUrl.trim().length > 0 },
              { label: '模型名称', done: activeProfile.model.trim().length > 0 },
            ].map((item) => (
              <div key={item.label} className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm">
                <span className="text-zinc-300">{item.label}</span>
                <span className={item.done ? 'text-emerald-200' : 'text-amber-200'}>
                  {item.done ? '已完成' : '待填写'}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-6 space-y-5">
            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-300">服务提供方</label>
              <select
                value={activeProvider}
                onChange={(event) => setActiveProvider(event.target.value as typeof activeProvider)}
                className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-zinc-100 focus:outline-none"
              >
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id} className="bg-[#101723]">
                    {provider.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-300">
                {requiresApiKey ? '密钥' : '本地服务密钥'}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={activeProfile.apiKey}
                  onChange={(event) => updateActiveProviderProfile({ apiKey: event.target.value })}
                  onBlur={(event) => updateActiveProviderProfile({ apiKey: event.target.value.trim() })}
                  placeholder={requiresApiKey ? '例如 sk-...' : '本地模型通常可以留空'}
                  className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 pr-12 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((value) => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 transition-linear hover:text-zinc-300"
                  aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-300">接口地址</label>
              <input
                type="text"
                value={activeProfile.baseUrl}
                onChange={(event) => updateActiveProviderProfile({ baseUrl: event.target.value })}
                onBlur={(event) => updateActiveProviderProfile({ baseUrl: event.target.value.trim() })}
                placeholder="https://api.example.com/v1"
                className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-300">模型名称</label>
              <input
                list="model-presets"
                value={activeProfile.model}
                onChange={(event) => updateActiveProviderProfile({ model: event.target.value })}
                onBlur={(event) => updateActiveProviderProfile({ model: event.target.value.trim() })}
                placeholder="例如 gpt-4o / deepseek-chat"
                className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
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

          <div className="mt-6 rounded-3xl border border-white/8 bg-white/[0.03] p-5 text-sm leading-6 text-zinc-400">
            <div className="flex items-start gap-3">
              <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />
              <div>
                <p className="font-medium text-zinc-200">你的配置只保存在本地浏览器</p>
                <p className="mt-1">
                  这一步不会改动后端服务。只要地址、模型和密钥完整，工坊的提取与融合流程就会点亮。
                </p>
              </div>
            </div>
          </div>
        </div>

        <footer className="linear-border-t px-6 py-5">
          <button
            onClick={onClose}
            className={`flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition-linear ${
              readiness
                ? 'border border-white/10 bg-white/[0.05] text-zinc-200 hover:bg-white/[0.08]'
                : 'border border-emerald-300/20 bg-emerald-300/14 text-emerald-50 hover:bg-emerald-300/18'
            }`}
          >
            {!readiness && <CheckCircle2 className="h-4 w-4" />}
            {readiness ? '先保存配置并返回' : '配置完成，返回继续创作'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
