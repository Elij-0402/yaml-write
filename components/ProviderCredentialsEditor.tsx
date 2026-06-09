'use client';

import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../app/store';
import { getProviderMeta, listProviderMetas } from '../app/llmProviders';

// 「选服务商 → API Key(显隐) → Base URL → 模型(datalist)」凭据表单的共享核心。
// SettingsPanel（抽屉，select 下拉）与 NovelUploader 滑入卡（tabs，含 Ollama 心跳）共用此组件：
// store 接线（activeProvider/profile/setActiveProvider/updateActiveProviderProfile）与字段渲染只此一处。
// 组件返回 fragment（无外层 spacing 容器），由宿主既有的 space-y 容器排布。
//
// collapsibleAdvanced：BYOK 无感模式。默认只露「当前模型(只读) + API Key」，把换服务商 / 自定义接口与模型
// 收进默认折叠的 <details>。绝大多数用户只需贴一把 key（默认 DeepSeek 已预填接口与模型）。

type Variant = 'minimal' | 'crystal';

interface EditorTheme {
  fieldWrap: string;
  label: string;
  select: string;
  hintCard: string;
  chipRow: string;
  chip: string;
  chipActive: string;
  chipMuted: string;
  keyRow: string;
  keyInput: string;
  toggleBtn: string;
  input: string;
  keyHelp: string;
  tabsWrap: string;
  tabBase: string;
  tabActive: string;
  tabInactive: string;
  advancedSummary: string;
  advancedBody: string;
}

// 冷调系统极简下两变体趋同（统一亮色），crystal 仅更紧凑些。
const SHARED = {
  chip: 'rounded-md border px-2.5 py-1 transition-colors',
  chipActive: 'border-accent bg-accent-subtle text-accent',
  chipMuted: 'border-line bg-surface text-fg-muted hover:text-fg hover:border-fg-subtle',
  keyRow: 'flex items-center gap-2',
  toggleBtn: 'btn btn-ghost btn-sm btn-icon shrink-0',
  tabBase: 'rounded-md border px-2.5 py-1 transition-colors',
  tabActive: 'border-accent bg-accent-subtle text-accent',
  tabInactive: 'border-line bg-surface text-fg-muted hover:text-fg',
};

const THEME: Record<Variant, EditorTheme> = {
  minimal: {
    fieldWrap: 'space-y-1.5',
    label: 'field-label',
    select: 'input text-sm',
    hintCard: 'rounded-lg border border-line bg-panel px-3 py-2.5 text-xs text-fg-muted',
    chipRow: 'flex flex-wrap gap-1.5',
    chip: `${SHARED.chip} text-xs`,
    chipActive: SHARED.chipActive,
    chipMuted: SHARED.chipMuted,
    keyRow: SHARED.keyRow,
    keyInput: 'input flex-1 text-sm font-mono',
    toggleBtn: SHARED.toggleBtn,
    input: 'input text-sm font-mono',
    keyHelp: 'text-xs text-fg-subtle',
    tabsWrap: 'flex flex-wrap gap-1.5',
    tabBase: `${SHARED.tabBase} text-sm`,
    tabActive: SHARED.tabActive,
    tabInactive: SHARED.tabInactive,
    advancedSummary: 'cursor-pointer select-none text-xs text-fg-muted hover:text-fg',
    advancedBody: 'mt-3 space-y-3',
  },
  crystal: {
    fieldWrap: 'space-y-1.5',
    label: 'field-label',
    select: 'input text-xs',
    hintCard: 'rounded-md border border-line bg-panel px-2.5 py-2 text-[11px] text-fg-muted',
    chipRow: 'flex flex-wrap gap-1.5',
    chip: `${SHARED.chip} text-[11px]`,
    chipActive: SHARED.chipActive,
    chipMuted: SHARED.chipMuted,
    keyRow: SHARED.keyRow,
    keyInput: 'input flex-1 text-xs font-mono',
    toggleBtn: SHARED.toggleBtn,
    input: 'input text-xs font-mono',
    keyHelp: 'text-[10px] text-fg-subtle',
    tabsWrap: 'flex flex-wrap gap-1.5',
    tabBase: `${SHARED.tabBase} text-[11px]`,
    tabActive: SHARED.tabActive,
    tabInactive: SHARED.tabInactive,
    advancedSummary: 'cursor-pointer select-none text-[11px] text-fg-subtle hover:text-fg',
    advancedBody: 'mt-2.5 space-y-3',
  },
};

interface ProviderCredentialsEditorProps {
  variant: Variant;
  providerSelector: 'select' | 'tabs';
  apiKeyLabel?: string;
  keyHelpText?: string;
  ollamaSlot?: React.ReactNode;
  collapsibleAdvanced?: boolean;
}

export default function ProviderCredentialsEditor({
  variant,
  providerSelector,
  apiKeyLabel,
  keyHelpText,
  ollamaSlot,
  collapsibleAdvanced,
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
  const currentModel = activeProfile.model.trim();
  const providerSummary = `${activeProviderMeta.shortName || activeProviderMeta.name} / ${currentModel || '未选择模型'}`;

  const providerSelectorEl =
    providerSelector === 'tabs' ? (
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
        <label className={t.label} htmlFor={`${variant}-provider`}>提供商</label>
        <select
          id={`${variant}-provider`}
          value={activeProvider}
          onChange={(e) => setActiveProvider(e.target.value as typeof activeProvider)}
          className={t.select}
        >
          {listProviderMetas().map((p) => (
            <option key={p.id} value={p.id}>
              {p.shortName || p.name}
              {p.defaultModel ? ` · ${p.defaultModel}` : ''}
            </option>
          ))}
        </select>
      </div>
    );

  const currentModelEl = (
    <div className={t.fieldWrap}>
      <label className={t.label}>当前模型</label>
      <div className={t.hintCard}>{providerSummary}</div>
    </div>
  );

  const apiKeyEl =
    !requiresApiKey && ollamaSlot ? (
      ollamaSlot
    ) : (
      <div className={t.fieldWrap}>
        <label className={t.label} htmlFor={`${variant}-apikey`}>{keyLabel}</label>
        <div className={t.keyRow}>
          <input
            id={`${variant}-apikey`}
            type={showKey ? 'text' : 'password'}
            value={activeProfile.apiKey}
            onChange={(e) => updateActiveProviderProfile({ apiKey: e.target.value })}
            onBlur={(e) => updateActiveProviderProfile({ apiKey: e.target.value.trim() })}
            placeholder="sk-..."
            className={t.keyInput}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className={t.toggleBtn}
            aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
          >
            {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {keyHelpText && <p className={t.keyHelp}>{keyHelpText}</p>}
      </div>
    );

  const baseUrlEl = (
    <div className={t.fieldWrap}>
      <label className={t.label} htmlFor={`${variant}-baseurl`}>接口地址</label>
      <input
        id={`${variant}-baseurl`}
        type="text"
        value={activeProfile.baseUrl}
        onChange={(e) => updateActiveProviderProfile({ baseUrl: e.target.value })}
        onBlur={(e) => updateActiveProviderProfile({ baseUrl: e.target.value.trim() })}
        placeholder="https://api.example.com"
        className={t.input}
      />
    </div>
  );

  const modelEl = (
    <div className={t.fieldWrap}>
      <label className={t.label} htmlFor={`${variant}-model`}>模型</label>
      {activeProviderMeta.modelPresets.length > 0 && (
        <div className={t.chipRow}>
          {activeProviderMeta.modelPresets.map((preset) => {
            const active = preset.value === currentModel;
            return (
              <button
                key={preset.value}
                type="button"
                onClick={() => updateActiveProviderProfile({ model: preset.value })}
                className={`${t.chip} ${active ? t.chipActive : t.chipMuted}`}
                title={preset.value}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      )}
      <input
        id={`${variant}-model`}
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
  );

  if (collapsibleAdvanced) {
    return (
      <>
        {currentModelEl}
        {apiKeyEl}
        <details>
          <summary className={t.advancedSummary}>更换模型提供方 · 自定义接口与模型</summary>
          <div className={t.advancedBody}>
            {providerSelectorEl}
            {baseUrlEl}
            {modelEl}
          </div>
        </details>
      </>
    );
  }

  return (
    <>
      {providerSelectorEl}
      {currentModelEl}
      {apiKeyEl}
      {baseUrlEl}
      {modelEl}
    </>
  );
}
