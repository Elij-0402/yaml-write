'use client';

import React, { useEffect, useRef, useState } from 'react';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  // 打开后把焦点移到首个可操作元素（输入框优先，否则主行动），满足键盘可达。
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => (inputRef.current ?? confirmRef.current)?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-fg/45 px-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="关闭对话框" tabIndex={-1} />
      <div className="card relative w-full max-w-md p-6 shadow-pop view-enter">
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        {description && <p className="mt-2 text-sm leading-6 text-fg-muted">{description}</p>}

        {inputLabel && (
          <div className="mt-4 space-y-1.5">
            <label className="field-label">{inputLabel}</label>
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(value); }}
              placeholder={placeholder}
              className="input text-sm"
            />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2.5">
          <button onClick={onClose} className="btn btn-ghost">{cancelLabel}</button>
          <button
            ref={confirmRef}
            onClick={() => onConfirm(inputLabel ? value : undefined)}
            className={`btn ${confirmTone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
