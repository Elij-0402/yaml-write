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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="关闭对话框" />
      <div className="relative w-full max-w-md rounded-[24px] border border-default bg-[linear-gradient(180deg,rgba(26,21,18,0.98),rgba(16,13,11,0.98))] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.35)]">
        <div className="eyebrow !mb-1">Confirm · 应用内确认</div>
        <h3 className="text-lg text-primary" style={{ fontFamily: 'var(--font-display)' }}>{title}</h3>
        <p className="mt-2 text-sm leading-6 text-secondary">{description}</p>

        {inputLabel && (
          <div className="mt-4 space-y-2">
            <label className="text-xs text-secondary">{inputLabel}</label>
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              className="w-full rounded-xl border border-default bg-black/10 px-3 py-2.5 text-sm text-primary focus:border-[color:var(--vermilion-line)] focus:outline-none"
            />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="mini">{cancelLabel}</button>
          <button
            onClick={() => onConfirm(inputLabel ? value : undefined)}
            className={`mini ${confirmTone === 'danger' ? '' : 'accept'}`}
            style={confirmTone === 'danger' ? { borderColor: 'var(--del)', color: 'var(--del)' } : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
