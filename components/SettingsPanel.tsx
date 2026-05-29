import React, { useState } from 'react';
import { useAppStore } from '../app/store';
import { Settings, Key, Globe, Cpu, Thermometer, CheckCircle2, XCircle, Loader2, X, Eye, EyeOff } from 'lucide-react';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', icon: '⚡' },
  { id: 'deepseek', name: 'DeepSeek', icon: '🐳' },
  { id: 'gemini', name: 'Google Gemini', icon: '✨' },
  { id: 'siliconflow', name: '硅基流动', icon: '🌊' },
  { id: 'ollama', name: 'Ollama 本地', icon: '🦙' },
  { id: 'custom', name: '自定义中转', icon: '⚙️' },
];

const PRESET_MODELS_MAP: Record<string, { label: string; value: string }[]> = {
  openai: [
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
  ],
  deepseek: [
    { label: 'DeepSeek Chat (V3)', value: 'deepseek-chat' },
    { label: 'DeepSeek Reasoner (R1)', value: 'deepseek-reasoner' },
  ],
  gemini: [
    { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
    { label: 'Gemini 1.5 Flash', value: 'gemini-1.5-flash' },
    { label: 'Gemini 1.5 Pro', value: 'gemini-1.5-pro' },
  ],
  siliconflow: [
    { label: 'DeepSeek V3 (硅基)', value: 'deepseek-ai/DeepSeek-V3' },
    { label: 'DeepSeek R1 (硅基)', value: 'deepseek-ai/DeepSeek-R1' },
    { label: 'Qwen 2.5 72B', value: 'Qwen/Qwen2.5-72B-Instruct' },
  ],
  ollama: [
    { label: 'Llama 3 (8B)', value: 'llama3' },
    { label: 'Qwen 2.5 (7B)', value: 'qwen2.5' },
  ],
  custom: []
};

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const { llmConfig, setLlmConfig } = useAppStore();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; latency?: number } | null>(null);
  const [showKey, setShowKey] = useState(false);

  if (!isOpen) return null;

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch('/api/py/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKey: llmConfig.apiKey,
          baseUrl: llmConfig.baseUrl,
          model: llmConfig.model,
        }),
      });
      const raw = await response.text();
      const data = raw ? JSON.parse(raw) : {};
      if (!response.ok) {
        throw new Error(data?.error?.message || `连接测试失败（HTTP ${response.status}）`);
      }
      setTestResult({
        success: Boolean(data.success),
        message: data.message || '连接测试完成。',
        latency: data.latency,
      });
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err.message || '网络连接超时，请检查您的网络设置或 Base URL 是否有效。',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Drawer Body */}
      <div className="relative w-full max-w-md h-full bg-zinc-900 border-l border-zinc-800 shadow-xl flex flex-col animate-slide-in">
        
        {/* Header */}
        <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-zinc-100">
                模型与密钥配置
              </h2>
              <p className="text-xs text-zinc-400">配置您的大模型 API 密钥与接口地址</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* 服务商选择 */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
              服务商 (Provider)
            </label>
            <div className="grid grid-cols-3 gap-2">
              {PROVIDERS.map((p) => {
                const isActive = (llmConfig.provider || 'openai') === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setLlmConfig({ provider: p.id as any })}
                    className={`p-3 rounded-xl border text-center transition-all flex flex-col items-center justify-center gap-1.5 ${
                      isActive
                        ? 'bg-zinc-800 border-zinc-500 text-white shadow-[0_0_12px_rgba(255,255,255,0.05)] scale-[1.02]'
                        : 'bg-zinc-950/40 border-zinc-900 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/30'
                    }`}
                  >
                    <span className="text-lg">{p.icon}</span>
                    <span className="text-[10px] font-medium truncate w-full">{p.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Base URL */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
              <Globe className="w-4 h-4 text-zinc-400" />
              API Base URL
            </label>
            <input 
              type="text"
              value={llmConfig.baseUrl}
              onChange={(e) => setLlmConfig({ baseUrl: e.target.value })}
              onBlur={(e) => setLlmConfig({ baseUrl: e.target.value.trim() })}
              placeholder="https://api.openai.com/v1"
              className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all font-mono text-sm"
            />
            <p className="text-xs text-zinc-500">兼容 OpenAI 规范的 API 地址。例如本地 Ollama 或自建中转</p>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
              <Key className="w-4 h-4 text-zinc-400" />
              API Key (密钥)
            </label>
            <div className="relative flex items-center">
              <input 
                type={showKey ? "text" : "password"}
                value={llmConfig.apiKey}
                onChange={(e) => setLlmConfig({ apiKey: e.target.value })}
                onBlur={(e) => setLlmConfig({ apiKey: e.target.value.trim() })}
                placeholder="sk-..."
                className="w-full px-4 py-3 pr-10 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-zinc-500">密钥仅安全保存在您浏览器本地 LocalStorage 中，不会泄露给第三方</p>
          </div>

          {/* Model Selection */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
              <Cpu className="w-4 h-4 text-zinc-400" />
              大模型名称
            </label>
            <input 
              type="text"
              value={llmConfig.model}
              onChange={(e) => setLlmConfig({ model: e.target.value })}
              onBlur={(e) => setLlmConfig({ model: e.target.value.trim() })}
              placeholder="选择或手动输入模型名称"
              className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all font-mono text-sm"
            />
            
            {/* Presets Grid */}
            {PRESET_MODELS_MAP[llmConfig.provider || 'openai']?.length > 0 && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                {PRESET_MODELS_MAP[llmConfig.provider || 'openai'].map((model) => (
                  <button
                    key={model.value}
                    onClick={() => setLlmConfig({ model: model.value })}
                    className={`px-3 py-2 rounded-lg text-xs font-mono border transition-all text-left truncate ${
                      llmConfig.model === model.value
                        ? 'bg-zinc-800 border-zinc-600 text-zinc-100 shadow-sm'
                        : 'bg-zinc-950/20 border-zinc-900 hover:border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {model.label}
                  </button>
                ))}
              </div>
            )}

            {/* Compatibility Warning Banner */}
            {(llmConfig.model.toLowerCase().includes('reasoner') || 
              llmConfig.model.toLowerCase().includes('r1')) && (
              <div className="mt-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-400 leading-relaxed animate-fade-in">
                ⚠️ <b>兼容性提示：</b>当前选择的“推理模型”在某些 API 聚合渠道中可能不支持系统在第 1 步所需的“章节分析结构化解析（Tool Call）”功能。建议在分析时切换为普通的 Chat 模型，而用此模型生成大纲及正文。
              </div>
            )}
          </div>

          {/* Temperature */}
          <div className="space-y-2">
            <div className="flex justify-between items-center text-sm font-semibold text-zinc-300">
              <label className="flex items-center gap-2">
                <Thermometer className="w-4 h-4 text-zinc-400" />
                随机温度 (Temperature)
              </label>
              <span className="font-mono text-zinc-300">{llmConfig.temperature}</span>
            </div>
            <input 
              type="range"
              min="0.0"
              max="1.5"
              step="0.1"
              value={llmConfig.temperature}
              onChange={(e) => setLlmConfig({ temperature: parseFloat(e.target.value) })}
              className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-zinc-300 focus:outline-none"
            />
            <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
              <span>0.0 (严肃精确)</span>
              <span>1.0 (平衡默认)</span>
              <span>1.5 (极富创意)</span>
            </div>
          </div>

          {/* Test Connection Result */}
          {testResult && (
            <div className={`p-4 rounded-xl border animate-fade-in ${
              testResult.success 
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-sm' 
                : 'bg-rose-500/10 border-rose-500/30 text-rose-400 shadow-sm'
            }`}>
              <div className="flex items-start gap-3">
                {testResult.success ? (
                  <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                )}
                <div className="text-sm flex-1">
                  <div className="flex justify-between items-center font-semibold">
                    <span>{testResult.success ? '连接成功' : '连接失败'}</span>
                    {testResult.latency !== undefined && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                        testResult.latency < 250 
                          ? 'bg-emerald-500/20 text-emerald-300' 
                          : testResult.latency < 600 
                          ? 'bg-amber-500/20 text-amber-300' 
                          : 'bg-rose-500/20 text-rose-300'
                      }`}>
                        延迟: {testResult.latency}ms
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed break-all">{testResult.message}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-zinc-800 bg-zinc-950/40 flex gap-3">
          <button 
            onClick={handleTestConnection}
            disabled={testing || (llmConfig.provider !== 'ollama' && !llmConfig.apiKey)}
            className="flex-1 py-3 rounded-xl bg-zinc-100 hover:bg-zinc-200 text-zinc-900 font-semibold shadow-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
          >
            {testing ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                测试连通性...
              </>
            ) : (
              '测试 API 连接'
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
