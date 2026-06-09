import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import ProviderCredentialsEditor from './ProviderCredentialsEditor';
import AppNotice from './AppNotice';
import { useFocusTrap } from '../app/useFocusTrap';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  returnHint?: string | null;
}

export default function SettingsPanel({ isOpen, onClose, returnHint }: SettingsPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(panelRef, isOpen);

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
      <button type="button" className="absolute inset-0 bg-fg/45" onClick={onClose} aria-label="关闭" />

      <aside ref={panelRef} className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-canvas shadow-pop view-enter">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
          <div>
            <div className="eyebrow">Settings</div>
            <span className="text-sm font-semibold text-fg">模型与偏好</span>
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-sm btn-icon" aria-label="关闭设置">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {returnHint && (
            <AppNotice tone="info" title="从这里跳转过来">
              待执行：{returnHint}。配置完后关闭面板，即可回到刚才那一步继续，无需重走流程。
            </AppNotice>
          )}

          <div className="card space-y-3 p-4">
            <div className="rounded-lg border border-line bg-panel px-4 py-3">
              <div className="text-sm font-medium text-fg">默认用 DeepSeek，贴上 API Key 即可解锁全流程</div>
              <p className="mt-1 text-xs leading-6 text-fg-muted">按量计费，起一本书的开篇通常只要几毛钱。接口与模型已预填；想换别的服务商，展开下方「更换模型提供方」。</p>
            </div>
            <ProviderCredentialsEditor variant="minimal" providerSelector="select" collapsibleAdvanced />
          </div>

          <p className="text-xs text-fg-subtle">密钥仅以混淆形式存储在浏览器本地，不会上传服务器。</p>
        </div>

        <footer className="shrink-0 border-t border-line p-5">
          <button onClick={onClose} className="btn btn-secondary w-full">返回刚才的流程</button>
        </footer>
      </aside>
    </div>
  );
}
