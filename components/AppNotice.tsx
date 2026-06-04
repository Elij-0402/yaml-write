'use client';

import React from 'react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const TONE_STYLES: Record<NoticeTone, { border: string; background: string; title: string; body: string }> = {
  info: {
    border: 'var(--line-strong)',
    background: 'rgba(137,147,161,.10)',
    title: 'var(--ink-text)',
    body: 'var(--ink-dim)',
  },
  success: {
    border: 'var(--add)',
    background: 'var(--add-soft)',
    title: 'var(--add)',
    body: 'var(--ink-dim)',
  },
  warning: {
    border: 'var(--vermilion-line)',
    background: 'var(--vermilion-soft)',
    title: 'var(--vermilion)',
    body: 'var(--ink-dim)',
  },
  error: {
    border: 'var(--del)',
    background: 'var(--del-soft)',
    title: 'var(--del)',
    body: 'var(--ink-dim)',
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
