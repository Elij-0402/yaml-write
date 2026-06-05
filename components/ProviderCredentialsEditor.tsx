'use client';

import React, { useState } from 'react';
import { useAppStore } from '../app/store';
import { getProviderMeta, listProviderMetas } from '../app/llmProviders';

// 「选服务商 → API Key(显隐) → Base URL → 模型(datalist)」凭据表单的共享核心。
// 此前 SettingsPanel（抽屉，select 下拉，极简主题）与 NovelUploader 水晶卡（tabs，深色主题，含 Ollama 心跳）
// 各复制一份绑定逻辑。现收成单一组件：store 接线（activeProvider/profile/setActiveProvider/updateActiveProviderProfile）
// 与字段渲染只此一处；宿主只提供外壳（抽屉 / 水晶卡）、主题变体、选择器样式与可选 Ollama 心跳槽。
// 组件返回 fragment（无外层 spacing 容器），由宿主既有的 space-y 容器排布，零额外布局节点。
//
// collapsibleAdvanced：BYOK 无感模式。默认只露「当前模型(只读) + API Key」，把换服务商 / 自定义接口与模型
// 收进默认折叠的 <details>。绝大多数用户只需贴一把 key（默认 DeepSeek 已预填接口与模型），高级用户再展开。

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

const THEME: Record<Variant, EditorTheme> = {
  minimal: {
    fieldWrap: 'space-y-2',
    label: 'text-xs text-secondary',
    select: 'workspace-input text-sm',
    hintCard: 'rounded-[12px] border border-default bg-black/10 px-3 py-2.5 text-xs text-secondary',
    chipRow: 'flex flex-wrap gap-2',
    chip: 'rounded-full border px-2.5 py-1 text-xs transition-colors',
    chipActive: 'border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)] text-primary',
    chipMuted: 'border-default bg-transparent text-secondary hover:text-primary',
    keyRow: 'flex items-center gap-2',
    keyInput: 'workspace-input flex-1 text-sm font-mono',
    toggleBtn: 'text-xs text-muted hover:text-primary',
    input: 'workspace-input text-sm font-mono',
    keyHelp: 'text-xs text-muted',
    tabsWrap: 'flex flex-wrap gap-1.5',
    tabBase: 'rounded-full border px-2.5 py-1 text-sm transition-colors',
    tabActive: 'border-[color:var(--vermilion-line)] bg-[color:var(--vermilion-soft)] text-primary',
    tabInactive: 'border-default bg-transparent text-muted hover:text-primary',
    advancedSummary: 'cursor-pointer select-none text-xs text-muted hover:text-primary',
    advancedBody: 'mt-3 space-y-4',
  },
  crystal: {
    fieldWrap: 'space-y-1.5',
    label: 'text-[11px] text-[color:var(--ink-dim)]',
    select: 'w-full border-2 border-[color:var(--ink)] bg-[color:var(--paper)] px-2.5 py-1.5 text-xs text-[color:var(--ink)] focus:border-[color:var(--blueprint)] focus:outline-none',
    hintCard: 'border-2 border-[color:var(--ink)] bg-[color:var(--paper)] px-2.5 py-2 text-[11px] text-[color:var(--ink-dim)]',
    chipRow: 'flex flex-wrap gap-1.5',
    chip: 'border px-2 py-1 text-[11px] transition-colors',
    chipActive: 'border-[color:var(--blueprint)] bg-[color:var(--blueprint-soft)] text-[color:var(--blueprint)]',
    chipMuted: 'border-[color:var(--ink)] bg-transparent text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]',
    keyRow: 'flex items-center gap-2',
    keyInput: 'flex-1 border-2 border-[color:var(--ink)] bg-[color:var(--paper)] px-2.5 py-1.5 font-mono text-xs text-[color:var(--ink)] focus:border-[color:var(--blueprint)] focus:outline-none',
    toggleBtn: 'shrink-0 text-[11px] text-[color:var(--ink-faint)] hover:text-[color:var(--ink)]',
    input: 'w-full border-2 border-[color:var(--ink)] bg-[color:var(--paper)] px-2.5 py-1.5 font-mono text-xs text-[color:var(--ink)] focus:border-[color:var(--blueprint)] focus:outline-none',
    keyHelp: 'text-[10px] text-[color:var(--ink-faint)]',
    tabsWrap: 'flex flex-wrap gap-1.5',
    tabBase: 'border px-2.5 py-1 text-[11px] transition-all',
    tabActive: 'border-[color:var(--blueprint)] bg-[color:var(--blueprint-soft)] text-[color:var(--blueprint)]',
    tabInactive: 'border-[color:var(--ink)] bg-transparent text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]',
    advancedSummary: 'cursor-pointer select-none text-[11px] text-[color:var(--ink-faint)] hover:text-[color:var(--ink)]',
    advancedBody: 'mt-2.5 space-y-3',
  },
};

interface ProviderCredentialsEditorProps {
  variant: Variant;
  providerSelector: 'select' | 'tabs';
  apiKeyLabel?: string;   // 覆盖 API Key 标签；缺省按 requiresApiKey 显示「API Key」/「API Key（可选）」
  keyHelpText?: string;   // 渲染在 API Key 输入下方的小字说明（如水晶卡的「🔒 …」）；缺省不渲染
  ollamaSlot?: React.ReactNode; // 选用「无需 Key」的本地 provider 时替换 API Key 输入（如 Ollama 心跳卡）
  collapsibleAdvanced?: boolean; // BYOK 无感：默认只露「当前模型 + Key」，换服务商/接口/模型收进折叠的高级区
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
        <label className={t.label}>提供商</label>
        <select
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
    );

  const baseUrlEl = (
    <div className={t.fieldWrap}>
      <label className={t.label}>接口地址</label>
      <input
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
      <label className={t.label}>模型</label>
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

  // 无感模式：默认只露「当前模型(只读) + API Key」，其余收进折叠的高级区。
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
