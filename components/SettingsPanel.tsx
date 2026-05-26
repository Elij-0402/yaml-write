import React, { useState } from 'react';
import { useAppStore } from '../app/store';
import { Settings, Key, Globe, Cpu, Thermometer, CheckCircle2, XCircle, Loader2, X } from 'lucide-react';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const PRESET_MODELS = [
  { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
  { label: 'Gemini 1.5 Flash', value: 'gemini-1.5-flash' },
  { label: 'DeepSeek Chat', value: 'deepseek-chat' },
  { label: 'DeepSeek Reasoner', value: 'deepseek-reasoner' },
  { label: 'GPT-4o', value: 'gpt-4o' },
  { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
  { label: 'Claude 3.5 Sonnet', value: 'claude-3-5-sonnet-20241022' },
];

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const { llmConfig, setLlmConfig } = useAppStore();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

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
      const data = await response.json();
      if (data.success) {
        setTestResult({ success: true, message: data.message });
      } else {
        setTestResult({ success: false, message: data.message || '连接失败，请检查配置。' });
      }
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || '网络请求错误，请稍后重试。' });
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
              placeholder="https://api.openai.com/v1"
              className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-650 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all font-mono text-sm"
            />
            <p className="text-xs text-zinc-550">兼容 OpenAI 规范的 API 地址。例如本地 Ollama 或自建中转</p>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
              <Key className="w-4 h-4 text-zinc-400" />
              API Key (密钥)
            </label>
            <input 
              type="password"
              value={llmConfig.apiKey}
              onChange={(e) => setLlmConfig({ apiKey: e.target.value })}
              placeholder="sk-..."
              className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-650 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all font-mono text-sm"
            />
            <p className="text-xs text-zinc-550">密钥仅安全保存在您浏览器本地 LocalStorage 中，不会泄露给第三方</p>
          </div>

          {/* Model Selection */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
              <Cpu className="w-4 h-4 text-zinc-400" />
              大模型名称
            </label>
            <div className="relative">
              <input 
                type="text"
                value={llmConfig.model}
                onChange={(e) => setLlmConfig({ model: e.target.value })}
                placeholder="选择或手动输入模型名称"
                className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-650 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all font-mono text-sm"
              />
            </div>
            
            {/* Presets Grid */}
            <div className="grid grid-cols-2 gap-2 mt-2">
              {PRESET_MODELS.map((model) => (
                <button
                  key={model.value}
                  onClick={() => setLlmConfig({ model: model.value })}
                  className={`px-3 py-2 rounded-lg text-xs font-mono border transition-all text-left truncate ${
                    llmConfig.model === model.value
                      ? 'bg-zinc-800 border-zinc-600 text-zinc-100 shadow-sm'
                      : 'bg-zinc-950/20 border-zinc-900 hover:border-zinc-850 text-zinc-450 hover:text-zinc-200'
                  }`}
                >
                  {model.label}
                </button>
              ))}
            </div>
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
            <div className="flex justify-between text-[10px] text-zinc-550 font-mono">
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
                <div className="text-sm">
                  <p className="font-semibold">{testResult.success ? '连接成功' : '连接失败'}</p>
                  <p className="text-xs text-zinc-400 mt-1 break-all">{testResult.message}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-zinc-800 bg-zinc-950/40 flex gap-3">
          <button 
            onClick={handleTestConnection}
            disabled={testing || !llmConfig.apiKey}
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
