'use client';

import React, { useState } from 'react';
import { useAppStore } from '../app/store';
import { getProviderMeta, listProviderMetas } from '../app/llmProviders';

// 「选服务商 → API Key(显隐) → Base URL → 模型(datalist)」凭据表单的共享核心。
// 此前 SettingsPanel（抽屉，select 下拉，极简主题）与 NovelUploader 水晶卡（tabs，深色主题，含 Ollama 心跳）
// 各复制一份绑定逻辑。现收成单一组件：store 接线（activeProvider/profile/setActiveProvider/updateActiveProviderProfile）
// 与字段渲染只此一处；宿主只提供外壳（抽屉 / 水晶卡）、主题变体、选择器样式与可选 Ollama 心跳槽。
// 组件返回 fragment（无外层 spacing 容器），由宿主既有的 space-y 容器排布，零额外布局节点。

type Variant = 'minimal' | 'crystal';

interface EditorTheme {
  fieldWrap: string;
  label: string;
  select: string;
  keyRow: string;
  keyInput: string;
  toggleBtn: string;
  input: string;
  keyHelp: string;
  tabsWrap: string;
  tabBase: string;
  tabActive: string;
  tabInactive: string;
}

const THEME: Record<Variant, EditorTheme> = {
  minimal: {
    fieldWrap: 'space-y-2',
    label: 'text-xs text-muted',
    select: 'w-full border bg-transparent p-2 text-sm focus:outline-none',
    keyRow: 'flex items-center gap-2',
    keyInput: 'flex-1 border bg-transparent p-2 text-sm font-mono focus:outline-none',
    toggleBtn: 'text-xs text-muted hover:text-secondary',
    input: 'w-full border bg-transparent p-2 text-sm font-mono focus:outline-none',
    keyHelp: 'text-xs text-muted',
    tabsWrap: 'flex flex-wrap gap-1.5',
    tabBase: 'border px-2.5 py-1 text-sm transition-colors',
    tabActive: 'bg-transparent text-primary',
    tabInactive: 'bg-transparent text-muted hover:text-secondary',
  },
  crystal: {
    fieldWrap: 'space-y-1.5',
    label: 'text-[11px] text-slate-400',
    select: 'w-full rounded border border-[#1b1e36] bg-[#080916] px-2.5 py-1.5 text-xs text-slate-200 focus:border-[#06b6d4] focus:outline-none',
    keyRow: 'flex items-center gap-2',
    keyInput: 'flex-1 rounded border border-[#1b1e36] bg-[#080916] px-2.5 py-1.5 font-mono text-xs text-slate-200 focus:border-[#06b6d4] focus:outline-none',
    toggleBtn: 'shrink-0 text-[11px] text-slate-500 hover:text-slate-300',
    input: 'w-full rounded border border-[#1b1e36] bg-[#080916] px-2.5 py-1.5 font-mono text-xs text-slate-200 focus:border-[#06b6d4] focus:outline-none',
    keyHelp: 'text-[10px] text-slate-600',
    tabsWrap: 'flex flex-wrap gap-1.5',
    tabBase: 'rounded-md border px-2.5 py-1 text-[11px] transition-all',
    tabActive: 'border-[#06b6d4]/40 bg-[#06b6d4]/15 text-[#67e8f9]',
    tabInactive: 'border-[#1b1e36] bg-transparent text-slate-400 hover:text-slate-200',
  },
};

interface ProviderCredentialsEditorProps {
  variant: Variant;
  providerSelector: 'select' | 'tabs';
  apiKeyLabel?: string;   // 覆盖 API Key 标签；缺省按 requiresApiKey 显示「API Key」/「API Key（可选）」
  keyHelpText?: string;   // 渲染在 API Key 输入下方的小字说明（如水晶卡的「🔒 …」）；缺省不渲染
  ollamaSlot?: React.ReactNode; // 选用「无需 Key」的本地 provider 时替换 API Key 输入（如 Ollama 心跳卡）
}

export default function ProviderCredentialsEditor({
  variant,
  providerSelector,
  apiKeyLabel,
  keyHelpText,
  ollamaSlot,
}: ProviderCredentialsEditorProps) {
  const { llmConfig, setActiveProvider, updateActiveProviderProfile } = useAppStore();
  const activeProvider = llmConfig.activeProvider;
  const activeProfile = llmConfig.providerProfiles[activeProvider];
  const activeProviderMeta = getProviderMeta(activeProvider);
  const requiresApiKey = activeProviderMeta.requiresApiKey;
  const [showKey, setShowKey] = useState(false);
  const t = THEME[variant];
  const datalistId = `${variant}-model-presets`;
  const keyLabel = apiKeyLabel ?? (requiresApiKey ? 'API Key' : 'API Key（可选）');

  return (
    <>
      {providerSelector === 'tabs' ? (
        <div className={t.tabsWrap}>
          {listProviderMetas().map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveProvider(p.id)}
              className={`${t.tabBase} ${activeProvider === p.id ? t.tabActive : t.tabInactive}`}
            >
              {p.name}
            </button>
          ))}
        </div>
      ) : (
        <div className={t.fieldWrap}>
          <label className={t.label}>提供商</label>
          <select
            value={activeProvider}
            onChange={(e) => setActiveProvider(e.target.value as typeof activeProvider)}
            className={t.select}
          >
            {listProviderMetas().map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {!requiresApiKey && ollamaSlot ? (
        ollamaSlot
      ) : (
        <div className={t.fieldWrap}>
          <label className={t.label}>{keyLabel}</label>
          <div className={t.keyRow}>
            <input
              type={showKey ? 'text' : 'password'}
              value={activeProfile.apiKey}
              onChange={(e) => updateActiveProviderProfile({ apiKey: e.target.value })}
              onBlur={(e) => updateActiveProviderProfile({ apiKey: e.target.value.trim() })}
              placeholder="sk-..."
              className={t.keyInput}
            />
            <button type="button" onClick={() => setShowKey((v) => !v)} className={t.toggleBtn}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          {keyHelpText && <p className={t.keyHelp}>{keyHelpText}</p>}
        </div>
      )}

      <div className={t.fieldWrap}>
        <label className={t.label}>Base URL</label>
        <input
          type="text"
          value={activeProfile.baseUrl}
          onChange={(e) => updateActiveProviderProfile({ baseUrl: e.target.value })}
          onBlur={(e) => updateActiveProviderProfile({ baseUrl: e.target.value.trim() })}
          placeholder="https://api.example.com/v1"
          className={t.input}
        />
      </div>

      <div className={t.fieldWrap}>
        <label className={t.label}>模型</label>
        <input
          list={datalistId}
          value={activeProfile.model}
          onChange={(e) => updateActiveProviderProfile({ model: e.target.value })}
          onBlur={(e) => updateActiveProviderProfile({ model: e.target.value.trim() })}
          placeholder="gpt-4o"
          className={t.input}
        />
        <datalist id={datalistId}>
          {activeProviderMeta.modelPresets.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label}</option>
          ))}
        </datalist>
      </div>
    </>
  );
}
