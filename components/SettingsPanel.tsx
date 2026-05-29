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
        setDiscoverMessage(`已获取 ${nextModels.length} 个可用模型。`);
      } else {
        setDiscoverMessage('未返回模型列表，可继续使用预设或手动输入。');
      }
    } catch {
      setDiscoveredModels([]);
      setDiscoverMessage('无法自动拉取模型，可继续使用预设或手动输入。');
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
        message: error instanceof Error ? error.message : '连接测试失败，请检查配置。',
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
      <button type="button" className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="关闭设置" />

      <aside className="relative h-full w-full max-w-md bg-zinc-950 border-l border-zinc-800 flex flex-col">
        <header className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">模型与密钥配置</h2>
            <p className="text-xs text-zinc-500 mt-1">全局配置，作用于全部流程</p>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <section className="space-y-2">
            <label className="text-xs text-zinc-400">服务商</label>
            <select
              value={activeProvider}
              onChange={(event) => setActiveProvider(event.target.value as typeof activeProvider)}
              className="w-full h-10 px-3 bg-zinc-950 border border-zinc-700 rounded text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
            >
              {providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </section>

          <section className="space-y-2">
            <label className="text-xs text-zinc-400">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={activeProfile.apiKey}
                onChange={(event) => updateActiveProviderProfile({ apiKey: event.target.value })}
                onBlur={(event) => updateActiveProviderProfile({ apiKey: event.target.value.trim() })}
                placeholder={requiresApiKey ? 'sk-...' : '本地服务可留空'}
                className="w-full h-10 px-3 pr-10 bg-zinc-950 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                className="absolute right-2 top-2 h-6 w-6 inline-flex items-center justify-center text-zinc-500 hover:text-zinc-300"
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-zinc-400">模型</label>
              <button
                type="button"
                onClick={() => void discoverModels(true)}
                disabled={discoveringModels}
                className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
              >
                {discoveringModels ? '拉取中...' : '刷新模型列表'}
              </button>
            </div>

            <select
              value={activeProfile.model}
              onChange={(event) => updateActiveProviderProfile({ model: event.target.value })}
              className="w-full h-10 px-3 bg-zinc-950 border border-zinc-700 rounded text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
            >
              {modelOptions.length === 0 ? (
                <option value="">未发现模型，请先配置或手动输入</option>
              ) : (
                modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))
              )}
            </select>

            {discoverMessage && <p className="text-xs text-zinc-500">{discoverMessage}</p>}
            {showReasonerWarning && (
              <p className="text-xs text-amber-400">当前模型可能不支持结构化章节解析，建议解析时改用普通 Chat 模型。</p>
            )}
          </section>

          <section className="border border-zinc-800 rounded">
            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              className="w-full h-10 px-3 text-left text-xs text-zinc-300 hover:bg-zinc-900"
            >
              {showAdvanced ? '收起高级设置' : '高级设置'}
            </button>
            {showAdvanced && (
              <div className="px-3 pb-3 space-y-3 border-t border-zinc-800">
                <div className="space-y-2 pt-3">
                  <label className="text-xs text-zinc-400">API Base URL</label>
                  <input
                    type="text"
                    value={activeProfile.baseUrl}
                    onChange={(event) => updateActiveProviderProfile({ baseUrl: event.target.value })}
                    onBlur={(event) => updateActiveProviderProfile({ baseUrl: event.target.value.trim() })}
                    placeholder="https://api.openai.com/v1"
                    className="w-full h-10 px-3 bg-zinc-950 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-zinc-400">手动模型名称</label>
                  <input
                    type="text"
                    value={activeProfile.model}
                    onChange={(event) => updateActiveProviderProfile({ model: event.target.value })}
                    onBlur={(event) => updateActiveProviderProfile({ model: event.target.value.trim() })}
                    placeholder="例如：gpt-4o"
                    className="w-full h-10 px-3 bg-zinc-950 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-zinc-400">Temperature</label>
                    <span className="text-xs text-zinc-400">{llmConfig.temperature.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.1"
                    value={llmConfig.temperature}
                    onChange={(event) => setTemperature(parseFloat(event.target.value))}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </section>

          {testResult && (
            <section
              className={`border rounded px-3 py-2 text-xs ${
                testResult.success ? 'border-emerald-700 text-emerald-300' : 'border-rose-700 text-rose-300'
              }`}
            >
              <p>{testResult.message}</p>
              {typeof testResult.latency === 'number' && <p className="mt-1 text-zinc-400">延迟 {testResult.latency} ms</p>}
            </section>
          )}
        </div>

        <footer className="px-5 py-4 border-t border-zinc-800">
          <button
            onClick={handleTestConnection}
            disabled={testing || !keyReady}
            className="w-full h-10 rounded border border-zinc-600 bg-zinc-100 text-zinc-900 text-sm font-medium hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                测试连接
              </span>
            ) : (
              '测试 API 连接'
            )}
          </button>
        </footer>
      </aside>
    </div>
  );
}
