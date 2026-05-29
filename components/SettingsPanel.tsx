import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Loader2, X } from 'lucide-react';
import { useAppStore } from '../app/store';
import { getProviderMeta, listProviderMetas } from '../app/llmProviders';
import { postWithLlmConfig, readApiErrorMessage } from '../app/llmClient';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TestResult {
  success: boolean;
  message: string;
  latency?: number;
}

interface ListModelsResult {
  models?: string[];
  message?: string;
}

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const { llmConfig, setActiveProvider, updateActiveProviderProfile, setTemperature } = useAppStore();
  const providerOptions = useMemo(() => listProviderMetas(), []);
  const activeProvider = llmConfig.activeProvider;
  const activeProviderMeta = getProviderMeta(activeProvider);
  const activeProfile = llmConfig.providerProfiles[activeProvider];

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null);

  const modelOptions = useMemo(() => {
    const values: string[] = [];
    const pushUnique = (value: string) => {
      const next = value.trim();
      if (!next) return;
      if (!values.includes(next)) values.push(next);
    };
    activeProviderMeta.modelPresets.forEach((item) => pushUnique(item.value));
    discoveredModels.forEach((item) => pushUnique(item));
    pushUnique(activeProfile.model);
    return values;
  }, [activeProfile.model, activeProviderMeta.modelPresets, discoveredModels]);

  useEffect(() => {
    if (!isOpen) return;
    setTestResult(null);
    setDiscoveredModels([]);
    setDiscoverMessage(null);
  }, [isOpen, activeProvider]);

  const discoverModels = useCallback(async (manual: boolean) => {
    const apiKey = activeProfile.apiKey.trim();
    const baseUrl = activeProfile.baseUrl.trim();
    if (!baseUrl) {
      setDiscoveredModels([]);
      if (manual) setDiscoverMessage('请先填写 API Base URL。');
      return;
    }
    if (activeProviderMeta.requiresApiKey && !apiKey) {
      setDiscoveredModels([]);
      if (manual) setDiscoverMessage('请先填写 API Key。');
      return;
    }

    setDiscoveringModels(true);
    if (manual) setDiscoverMessage(null);

    try {
      const response = await postWithLlmConfig('/api/py/list-models', {}, { includeTemperature: false });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, '模型列表拉取失败'));
      }

      const data = (await response.json()) as ListModelsResult;
      const nextModels = Array.isArray(data.models)
        ? data.models.filter((item) => typeof item === 'string' && item.trim().length > 0)
        : [];
      setDiscoveredModels(nextModels);
      if (nextModels.length > 0) {
        setDiscoverMessage(`自动发现 ${nextModels.length} 个可用模型。`);
      } else {
        setDiscoverMessage('未发现公开模型列表，请直接使用内置预设。');
      }
    } catch {
      setDiscoveredModels([]);
      setDiscoverMessage('无法连接发现服务，请继续使用内置预设。');
    } finally {
      setDiscoveringModels(false);
    }
  }, [activeProfile.apiKey, activeProfile.baseUrl, activeProviderMeta.requiresApiKey]);

  useEffect(() => {
    if (!isOpen) return;
    const apiKey = activeProfile.apiKey.trim();
    const baseUrl = activeProfile.baseUrl.trim();
    if (!baseUrl || (activeProviderMeta.requiresApiKey && !apiKey)) {
      setDiscoveredModels([]);
      setDiscoverMessage(null);
      return;
    }

    const timer = window.setTimeout(() => {
      void discoverModels(false);
    }, 550);

    return () => window.clearTimeout(timer);
  }, [isOpen, activeProvider, activeProfile.apiKey, activeProfile.baseUrl, activeProviderMeta.requiresApiKey, discoverModels]);

  if (!isOpen) return null;

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await postWithLlmConfig('/api/py/test-connection', {}, { includeTemperature: false });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, '连接测试失败'));
      }
      const data = (await response.json()) as TestResult;
      setTestResult({
        success: Boolean(data.success),
        message: data.message || '连接测试完成。',
        latency: data.latency,
      });
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : '连接配置校验失败，请核对密钥与 API 基址。',
      });
    } finally {
      setTesting(false);
    }
  };

  const requiresApiKey = activeProviderMeta.requiresApiKey;
  const modelNameLower = activeProfile.model.toLowerCase();
  const showReasonerWarning = modelNameLower.includes('reasoner') || modelNameLower.includes('r1');
  const keyReady = !requiresApiKey || activeProfile.apiKey.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button 
        type="button" 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" 
        onClick={onClose} 
        aria-label="关闭设置" 
      />

      <aside className="relative h-full w-full max-w-sm bg-[#08080a] border-l border-zinc-850 shadow-2xl flex flex-col rounded-none animate-slide-in font-sans">
        
        {/* Drawer Header */}
        <header className="px-5 py-4 border-b border-zinc-900 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-xs font-bold text-zinc-200 uppercase tracking-widest font-mono">大模型密钥与基址</h2>
            <p className="text-[10px] text-zinc-550 mt-1">全局配置，数据持久化于本地浏览器中</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded border border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900 transition-linear active-press"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </header>

        {/* Drawer Body Form */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          
          <section className="flex flex-col gap-1.5">
            <label className="text-[10px] text-zinc-550 font-bold uppercase tracking-wider font-mono">提供商 (Provider)</label>
            <select
              value={activeProvider}
              onChange={(event) => setActiveProvider(event.target.value as typeof activeProvider)}
              className="w-full h-9 px-3 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 focus:outline-none focus:border-zinc-750 transition-linear cursor-pointer"
            >
              {providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id} className="bg-[#121214]">
                  {provider.name}
                </option>
              ))}
            </select>
          </section>

          <section className="flex flex-col gap-1.5">
            <label className="text-[10px] text-zinc-550 font-bold uppercase tracking-wider font-mono">密钥 (API Key)</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={activeProfile.apiKey}
                onChange={(event) => updateActiveProviderProfile({ apiKey: event.target.value })}
                onBlur={(event) => updateActiveProviderProfile({ apiKey: event.target.value.trim() })}
                placeholder={requiresApiKey ? 'sk-...' : '本地大模型运行，可不填 API Key'}
                className="w-full h-9 px-3 pr-10 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 placeholder-zinc-650 focus:outline-none focus:border-zinc-700 transition-linear"
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                className="absolute right-2 top-1.5 h-6 w-6 inline-flex items-center justify-center text-zinc-550 hover:text-zinc-300 active-press transition-linear"
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </section>

          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-zinc-550 font-bold uppercase tracking-wider font-mono">目标模型 (Model)</label>
              <button
                type="button"
                onClick={() => void discoverModels(true)}
                disabled={discoveringModels}
                className="text-[9px] text-zinc-500 hover:text-zinc-300 font-mono underline"
              >
                {discoveringModels ? '读取中...' : '自动扫描可用模型'}
              </button>
            </div>

            <select
              value={activeProfile.model}
              onChange={(event) => updateActiveProviderProfile({ model: event.target.value })}
              className="w-full h-9 px-3 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 focus:outline-none focus:border-zinc-700 transition-linear cursor-pointer"
            >
              {modelOptions.length === 0 ? (
                <option value="" className="bg-[#121214] text-zinc-500">未发现模型，请检查配置或高级输入</option>
              ) : (
                modelOptions.map((model) => (
                  <option key={model} value={model} className="bg-[#121214]">
                    {model}
                  </option>
                ))
              )}
            </select>

            {discoverMessage && <p className="text-[9px] text-zinc-550 font-mono mt-0.5 leading-relaxed">{discoverMessage}</p>}
            {showReasonerWarning && (
              <p className="text-[10px] text-amber-500 leading-relaxed bg-amber-950/20 border border-amber-900/30 p-2 rounded mt-1.5">
                警告：当前选择的模型包含 r1 或 reasoner，深度推理大模型可能不支持 structure 结构化格式输出，导致解析章节提取元素失败。若解析报错，请换用标准大模型（如 gpt-4o, gemini-1.5-pro 等）。
              </p>
            )}
          </section>

          {/* Advanced config collapse panel */}
          <section className="border border-zinc-900 rounded overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              className="w-full h-9 px-3 text-left text-[11px] text-zinc-400 hover:bg-zinc-900 transition-linear font-semibold"
            >
              {showAdvanced ? '收起 API 高级设置' : '展开 API 高级设置 (自定义 URL 基址)'}
            </button>
            {showAdvanced && (
              <div className="px-3 pb-3 space-y-3 border-t border-zinc-900 bg-zinc-950/20 animate-fade-in">
                <div className="space-y-1.5 pt-3">
                  <label className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider font-mono">API Base URL</label>
                  <input
                    type="text"
                    value={activeProfile.baseUrl}
                    onChange={(event) => updateActiveProviderProfile({ baseUrl: event.target.value })}
                    onBlur={(event) => updateActiveProviderProfile({ baseUrl: event.target.value.trim() })}
                    placeholder="https://api.openai.com/v1"
                    className="w-full h-9 px-3 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 placeholder-zinc-650 focus:outline-none focus:border-zinc-700 transition-linear"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider font-mono">手动模型代号 Override</label>
                  <input
                    type="text"
                    value={activeProfile.model}
                    onChange={(event) => updateActiveProviderProfile({ model: event.target.value })}
                    onBlur={(event) => updateActiveProviderProfile({ model: event.target.value.trim() })}
                    placeholder="例如：deepseek-coder"
                    className="w-full h-9 px-3 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-200 placeholder-zinc-650 focus:outline-none focus:border-zinc-700 transition-linear"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider font-mono">温度 (Temperature)</label>
                    <span className="text-[10px] text-zinc-400 font-mono">{llmConfig.temperature.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.1"
                    value={llmConfig.temperature}
                    onChange={(event) => setTemperature(parseFloat(event.target.value))}
                    className="w-full h-1 bg-zinc-850 rounded-lg appearance-none cursor-pointer accent-amber-500"
                  />
                </div>
              </div>
            )}
          </section>

          {/* Test results diagnostic panel */}
          {testResult && (
            <section
              className={`border rounded p-3 text-[11px] font-mono leading-relaxed animate-fade-in ${
                testResult.success 
                  ? 'bg-emerald-950/20 border-emerald-900/30 text-emerald-400' 
                  : 'bg-rose-950/20 border-rose-900/30 text-rose-455'
              }`}
            >
              <p className="font-semibold">{testResult.success ? '✓ 连通性测试成功' : '✗ 连通性测试异常'}</p>
              <p className="mt-1 opacity-90">{testResult.message}</p>
              {typeof testResult.latency === 'number' && (
                <p className="mt-1 text-zinc-500 font-medium">基准延迟：{testResult.latency} ms</p>
              )}
            </section>
          )}
        </div>

        {/* Drawer Footer Actions */}
        <footer className="px-5 py-4 border-t border-zinc-900 bg-[#060608] shrink-0">
          <button
            onClick={handleTestConnection}
            disabled={testing || !keyReady}
            className="w-full h-9 rounded bg-zinc-100 hover:bg-zinc-200 disabled:bg-zinc-900 text-zinc-950 disabled:text-zinc-650 text-xs font-bold transition-linear active-press flex items-center justify-center gap-1.5"
          >
            {testing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                正在校验连接并测速...
              </>
            ) : (
              '测试并校验 API 连接'
            )}
          </button>
        </footer>
      </aside>
    </div>
  );
}
