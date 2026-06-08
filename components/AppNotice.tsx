'use client';

import React from 'react';
import { Info, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const TONE: Record<NoticeTone, { wrap: string; title: string; Icon: typeof Info }> = {
  info: {
    wrap: 'border-line bg-surface',
    title: 'text-fg',
    Icon: Info,
  },
  success: {
    wrap: 'border-success/40 bg-[color:var(--accent-subtle)]',
    title: 'text-success',
    Icon: CheckCircle2,
  },
  warning: {
    // 软提示 = 非告警：中性面 + 中性标题，仅图标点出风险（不用 danger 红）。
    wrap: 'border-line bg-panel',
    title: 'text-fg',
    Icon: AlertTriangle,
  },
  error: {
    wrap: 'border-danger/40 bg-danger-subtle',
    title: 'text-danger',
    Icon: AlertCircle,
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
  const { wrap, title: titleColor, Icon } = TONE[tone];

  return (
    <div className={`rounded-lg border px-4 py-3.5 ${wrap} ${className}`} role={tone === 'error' ? 'alert' : undefined}>
      {title ? (
        <div className={`flex items-center gap-2 text-sm font-medium ${titleColor}`}>
          <Icon size={15} strokeWidth={2} className="shrink-0" />
          {title}
        </div>
      ) : null}
      <div className={`${title ? 'mt-1.5 pl-[23px]' : ''} text-xs leading-6 text-fg-muted`}>{children}</div>
      {action ? <div className={`mt-3 ${title ? 'pl-[23px]' : ''}`}>{action}</div> : null}
    </div>
  );
}
