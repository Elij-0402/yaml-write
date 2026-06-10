'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../app/useFocusTrap';

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
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  // 焦点陷阱：打开移焦入对话框（优先输入框）、Tab 循环不逃逸、关闭归还焦点给触发元素。
  useFocusTrap(dialogRef, open);

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="absolute inset-0 bg-scrim" onClick={onClose} aria-label="关闭对话框" tabIndex={-1} />
      <div ref={dialogRef} className="glass pop-enter relative w-full max-w-[400px] rounded-lg p-5 shadow-pop">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {description && <p className="mt-2 text-[13px] leading-6 text-fg-muted">{description}</p>}

        {inputLabel && (
          <div className="mt-4 space-y-1.5">
            <label className="field-label" htmlFor="app-dialog-input">{inputLabel}</label>
            <input
              id="app-dialog-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(value); }}
              placeholder={placeholder}
              className="input"
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">{cancelLabel}</button>
          <button
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
