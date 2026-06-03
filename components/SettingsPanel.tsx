import React, { useEffect, useMemo } from 'react';
import { useAppStore } from '../app/store';
import { getLlmConfigError } from '../app/llmClient';
import ProviderCredentialsEditor from './ProviderCredentialsEditor';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  returnHint?: string | null;
}

export default function SettingsPanel({ isOpen, onClose, returnHint }: SettingsPanelProps) {
  const { llmConfig } = useAppStore();

  const readiness = useMemo(() => getLlmConfigError(llmConfig), [llmConfig]);

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
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="关闭" />

      <aside className="relative flex h-full w-full max-w-md flex-col border-l bg-black">
        <header className="flex h-12 items-center justify-between border-b px-6">
          <span className="text-sm">设置</span>
          <button onClick={onClose} className="text-secondary hover:text-primary">×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Status */}
          <div className="flex items-center gap-3 text-sm">
            <span className={readiness ? 'text-amber-500' : 'text-emerald-500'}>
              {readiness ? '○' : '●'}
            </span>
            <span>{readiness || '配置完成'}</span>
          </div>

          {returnHint && <p className="text-xs text-muted">待执行: {returnHint}</p>}

          {/* Form */}
          <div className="space-y-4">
            <ProviderCredentialsEditor variant="minimal" providerSelector="select" />
          </div>

          <p className="text-xs text-muted">密钥仅存储在浏览器本地，不会上传服务器。</p>
        </div>

        <footer className="border-t p-6">
          <button onClick={onClose} className="w-full py-2 text-sm text-secondary hover:text-primary">
            关闭
          </button>
        </footer>
      </aside>
    </div>
  );
}
