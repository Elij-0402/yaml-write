import React, { useEffect } from 'react';
import { useAppStore } from '../app/store';
import ProviderCredentialsEditor from './ProviderCredentialsEditor';
import AppNotice from './AppNotice';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  returnHint?: string | null;
}

export default function SettingsPanel({ isOpen, onClose, returnHint }: SettingsPanelProps) {
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
      <button type="button" className="absolute inset-0 bg-[rgba(7,5,4,0.76)] backdrop-blur-sm" onClick={onClose} aria-label="关闭" />

      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-default bg-[linear-gradient(180deg,rgba(20,16,13,0.985),rgba(28,22,18,0.98))] shadow-[-20px_0_60px_rgba(0,0,0,0.28)]">
        <header className="flex h-16 items-center justify-between border-b border-default px-6">
          <div>
            <div className="eyebrow !mb-0">模型设置</div>
            <span className="text-base text-primary">设置中心</span>
          </div>
          <button onClick={onClose} className="text-secondary hover:text-primary">×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {returnHint && (
            <AppNotice tone="warning" title="你是从这里跳转过来的">
              待执行：{returnHint}。配置完后关闭抽屉，就可以回到刚才那一步继续，不需要重走流程。
            </AppNotice>
          )}

          <div className="space-y-3 rounded-[24px] border border-default bg-black/10 p-4">
            <div className="rounded-[18px] border border-default bg-[rgba(239,230,214,0.04)] px-4 py-3">
              <div className="text-sm text-primary">连接模型之后，当前工作流会自动恢复</div>
              <p className="mt-1 text-xs leading-6 text-secondary">这里不只是存配置，也是整个创作流程的“解锁点”。完成后直接回到刚才卡住的步骤即可。</p>
            </div>
            <ProviderCredentialsEditor variant="minimal" providerSelector="select" />
          </div>

          <p className="text-xs text-muted">密钥仅存储在浏览器本地，不会上传服务器。</p>
        </div>

        <footer className="border-t border-default p-6">
          <button onClick={onClose} className="w-full rounded-xl border border-default bg-secondary py-2 text-sm text-primary hover:border-[color:var(--vermilion-line)]">
            返回刚才的流程
          </button>
        </footer>
      </aside>
    </div>
  );
}
