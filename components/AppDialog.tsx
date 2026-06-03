'use client';

import React, { useEffect, useState } from 'react';

interface AppDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirmTone?: 'default' | 'danger';
  inputLabel?: string;
  initialValue?: string;
  placeholder?: string;
  onConfirm: (value?: string) => void;
  onClose: () => void;
}

export default function AppDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  confirmTone = 'default',
  inputLabel,
  initialValue = '',
  placeholder,
  onConfirm,
  onClose,
}: AppDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(7,5,4,0.78)] px-4 backdrop-blur-sm">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="关闭对话框" />
      <div className="relative w-full max-w-md rounded-[28px] border border-default bg-[linear-gradient(180deg,rgba(30,24,20,0.985),rgba(14,11,9,0.99))] p-6 shadow-[0_40px_100px_rgba(0,0,0,0.42)]">
        <div className="eyebrow !mb-2">Confirm · 应用内确认</div>
        <h3 className="text-[22px] text-primary" style={{ fontFamily: 'var(--font-display)', lineHeight: 1.2 }}>{title}</h3>
        <p className="mt-2 text-sm leading-6 text-secondary">{description}</p>

        {inputLabel && (
          <div className="mt-4 space-y-2">
            <label className="text-xs text-secondary">{inputLabel}</label>
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              className="workspace-input text-sm"
            />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="workspace-button workspace-button-secondary">{cancelLabel}</button>
          <button
            onClick={() => onConfirm(inputLabel ? value : undefined)}
            className={`workspace-button ${confirmTone === 'danger' ? 'workspace-button-secondary' : ''}`}
            style={confirmTone === 'danger' ? { borderColor: 'var(--del)', color: 'var(--del)', background: 'rgba(192,82,74,0.08)' } : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
