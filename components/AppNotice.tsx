'use client';

import React from 'react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const TONE_STYLES: Record<NoticeTone, { border: string; background: string; title: string; body: string }> = {
  info: {
    border: 'var(--hair)',
    background: 'var(--surface)',
    title: 'var(--ink)',
    body: 'var(--muted)',
  },
  success: {
    border: 'var(--signal)',
    background: 'var(--signal-soft)',
    title: 'var(--signal)',
    body: 'var(--muted)',
  },
  warning: {
    border: 'var(--hair)',
    background: 'var(--surface)',
    title: 'var(--ink)',
    body: 'var(--muted)',
  },
  error: {
    border: 'var(--danger)',
    background: 'var(--danger-soft)',
    title: 'var(--danger)',
    body: 'var(--muted)',
  },
};

export default function AppNotice({
  tone,
  title,
  children,
  action,
  className = '',
}: {
  tone: NoticeTone;
  title?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const style = TONE_STYLES[tone];

  return (
    <div
      className={`rounded-[12px] border px-4 py-3.5 text-sm ${className}`}
      style={{ borderColor: style.border, background: style.background }}
    >
      {title ? (
        <div className="flex items-center gap-2 font-semibold" style={{ color: style.title }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: style.title }} />
          {title}
        </div>
      ) : null}
      <div className={`${title ? 'mt-2' : ''} text-xs leading-6`} style={{ color: style.body }}>
        {children}
      </div>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
