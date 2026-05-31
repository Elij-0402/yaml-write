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
      <button type="button" className="absolute inset-0 bg-black/80 backdrop-blur-xs" onClick={onClose} aria-label="关闭设置" />

      <aside className="animate-slide-in relative flex h-full w-full max-w-[420px] flex-col border-l border-white/5 bg-[#050505] shadow-2xl">
        <header className="linear-border-b px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-xs text-zinc-400">
                <Orbit className="h-3.5 w-3.5 text-zinc-300" />
                模型配置底座
              </div>
              <h2 className="mt-4 text-lg font-semibold text-zinc-100 tracking-tight">配置大模型引擎</h2>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                密钥仅在此浏览器本地存储（LocalStorage）。点亮引擎后，章节映射、DNA 提炼与创意碰撞逻辑将自动点亮。
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-full border border-white/5 p-1.5 text-zinc-600 transition-linear hover:border-white/15 hover:text-zinc-200"
              aria-label="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className={`rounded-xl border p-5 bg-zinc-950/40 flex items-start gap-4 ${
            readiness ? 'border-white/5' : 'border-white/10'
          }`}>
            <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
              readiness ? 'bg-amber-500 animate-pulse shadow-[0_0_6px_#f59e0b]' : 'bg-emerald-500 shadow-[0_0_6px_#10b981]'
            }`} />
            <div>
              <p className="text-[10px] font-mono tracking-wider text-zinc-600 uppercase">ENGINE_STATUS</p>
              <h3 className="mt-1 text-sm font-semibold text-zinc-250">
                {readiness ? '还有前置配置待点亮' : '模型引擎配置完好'}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
                {readiness ? readiness : '链路已完全畅通，可直接返回工作台继续创作心流。'}
              </p>
              {returnHint && (
                <div className="mt-3 rounded-lg border border-white/5 bg-white/[0.01] px-3 py-2 text-[11px] text-zinc-450 font-mono">
                  PENDING_TASK: <span className="text-zinc-300">{returnHint}</span>
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 grid gap-2.5 font-mono text-[11px]">
            {[
              { label: '服务提供商', done: true },
              { label: requiresApiKey ? 'API 接口密钥' : '本地接口密钥', done: !requiresApiKey || activeProfile.apiKey.trim().length > 0 },
              { label: 'BASE_URL 地址', done: activeProfile.baseUrl.trim().length > 0 },
              { label: 'MODEL 预设模型', done: activeProfile.model.trim().length > 0 },
            ].map((item) => (
              <div key={item.label} className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.015] px-4 py-2.5 text-zinc-400">
                <span>{item.label}</span>
                <span className={item.done ? 'text-zinc-400 font-medium' : 'text-amber-500 font-medium animate-pulse'}>
                  {item.done ? 'READY' : 'REQUIRED'}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <label className="mb-1.5 block text-[10px] font-mono text-zinc-500">PROVIDER / 提供方</label>
              <select
                value={activeProvider}
                onChange={(event) => setActiveProvider(event.target.value as typeof activeProvider)}
                className="h-10 w-full rounded-xl border border-white/5 bg-zinc-950 px-3 text-xs text-zinc-200 focus:outline-none focus:border-white/15"
              >
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id} className="bg-[#0c0c0e]">
                    {provider.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-[10px] font-mono text-zinc-500">
                {requiresApiKey ? 'API_KEY / 接口密钥' : 'LOCAL_KEY / 本地密钥'}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={activeProfile.apiKey}
                  onChange={(event) => updateActiveProviderProfile({ apiKey: event.target.value })}
                  onBlur={(event) => updateActiveProviderProfile({ apiKey: event.target.value.trim() })}
                  placeholder={requiresApiKey ? 'sk-...' : '本地引擎可直接留空'}
                  className="h-10 w-full rounded-xl border border-white/5 bg-zinc-950 px-4 pr-12 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-white/15"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((value) => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 transition-linear hover:text-zinc-300"
                  aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[10px] font-mono text-zinc-500">BASE_URL / 接口端点地址</label>
              <input
                type="text"
                value={activeProfile.baseUrl}
                onChange={(event) => updateActiveProviderProfile({ baseUrl: event.target.value })}
                onBlur={(event) => updateActiveProviderProfile({ baseUrl: event.target.value.trim() })}
                placeholder="https://api.example.com/v1"
                className="h-10 w-full rounded-xl border border-white/5 bg-zinc-950 px-4 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-white/15"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[10px] font-mono text-zinc-500">MODEL_NAME / 拟合模型名称</label>
              <input
                list="model-presets"
                value={activeProfile.model}
                onChange={(event) => updateActiveProviderProfile({ model: event.target.value })}
                onBlur={(event) => updateActiveProviderProfile({ model: event.target.value.trim() })}
                placeholder="例如 gpt-4o / deepseek-chat"
                className="h-10 w-full rounded-xl border border-white/5 bg-zinc-950 px-4 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-white/15"
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

          <div className="mt-6 rounded-xl border border-white/5 bg-white/[0.015] p-4 text-xs leading-relaxed text-zinc-500">
            <div className="flex items-start gap-3">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <div>
                <p className="font-semibold text-zinc-400">密钥沙箱保证 (SANDBOX_SAFE)</p>
                <p className="mt-1">
                  您的密钥在底层以沙箱形式保护在 LocalStorage 中，永不触碰云端或中间服务器，在前端随调用发生而直接封装至 LLM Body。
                </p>
              </div>
            </div>
          </div>
        </div>

        <footer className="linear-border-t px-6 py-5 bg-[#030303]">
          <button
            onClick={onClose}
            className={`flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-xs font-semibold transition-linear ${
              readiness
                ? 'border border-white/5 bg-white/[0.02] text-zinc-350 hover:bg-white/[0.04]'
                : 'border border-white/10 bg-white/[0.05] text-white hover:bg-white/[0.08] active-press'
            }`}
          >
            {!readiness && <CheckCircle2 className="h-3.5 w-3.5 text-zinc-300" />}
            {readiness ? '保存修改并暂退' : '配置链完好，返回继续心流'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
