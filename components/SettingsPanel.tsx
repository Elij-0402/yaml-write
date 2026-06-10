'use client';

import React, { useEffect, useRef } from 'react';
import { Monitor, Moon, Sun, X } from 'lucide-react';
import ProviderCredentialsEditor from './ProviderCredentialsEditor';
import AppNotice from './AppNotice';
import { useFocusTrap } from '../app/useFocusTrap';
import { useTheme, type ThemePreference } from '../app/theme';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  returnHint?: string | null;
}

const THEME_OPTIONS: { pref: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { pref: 'system', label: '跟随系统', Icon: Monitor },
  { pref: 'light', label: '亮色', Icon: Sun },
  { pref: 'dark', label: '暗色', Icon: Moon },
];

export default function SettingsPanel({ isOpen, onClose, returnHint }: SettingsPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(panelRef, isOpen);
  const { preference, setPreference } = useTheme();

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

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="设置">
      <button type="button" className="absolute inset-0 bg-scrim" onClick={onClose} aria-label="关闭" />

      <aside ref={panelRef} className="slide-in-right relative flex h-full w-full max-w-md flex-col border-l border-line bg-canvas shadow-pop">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <span className="text-[13px] font-semibold text-fg">设置</span>
          <div className="flex items-center gap-2">
            <span className="kbd">Esc</span>
            <button onClick={onClose} className="btn btn-ghost btn-sm btn-icon" aria-label="关闭设置">
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {returnHint && (
            <AppNotice tone="info" title="从这里跳转过来">
              待执行：{returnHint}。配置完后关闭面板，即可回到刚才那一步继续，无需重走流程。
            </AppNotice>
          )}

          {/* 外观 */}
          <section className="space-y-2.5">
            <div className="eyebrow">外观</div>
            <div className="seg" role="radiogroup" aria-label="主题">
              {THEME_OPTIONS.map(({ pref, label, Icon }) => (
                <button
                  key={pref}
                  type="button"
                  role="radio"
                  aria-checked={preference === pref}
                  onClick={() => setPreference(pref)}
                  className="seg-item"
                >
                  <Icon size={13} className="shrink-0" /> {label}
                </button>
              ))}
            </div>
            <p className="text-xs leading-5 text-fg-subtle">暗色为默认基调；两套主题均经过对比度校准。</p>
          </section>

          {/* 模型 */}
          <section className="space-y-3">
            <div className="eyebrow">模型</div>
            <div className="rounded-lg border border-line bg-panel px-3.5 py-3">
              <div className="text-[13px] font-medium text-fg">默认用 DeepSeek，贴上 API Key 即可解锁全流程</div>
              <p className="mt-1 text-xs leading-6 text-fg-muted">按量计费，起一本书的开篇通常只要几毛钱。接口与模型已预填；想换别的服务商，展开下方「更换模型提供方」。</p>
            </div>
            <div className="card space-y-3 p-4">
              <ProviderCredentialsEditor variant="minimal" providerSelector="select" collapsibleAdvanced />
            </div>
            <p className="text-xs text-fg-subtle">密钥仅以混淆形式存储在浏览器本地，不会上传服务器。</p>
          </section>
        </div>

        <footer className="shrink-0 border-t border-line p-4">
          <button onClick={onClose} className="btn btn-secondary w-full">完成，回到刚才的流程</button>
        </footer>
      </aside>
    </div>
  );
}
