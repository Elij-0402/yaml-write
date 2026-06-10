'use client';

import React from 'react';
import { Info, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

// 调性横幅：info=中性面；warning=软提示（中性面 + 图标点风险，不用红）；
// success/error 用按主题校准的弱底 + 校准文字色。
const TONE: Record<NoticeTone, { wrap: string; title: string; Icon: typeof Info }> = {
  info: {
    wrap: 'border-line bg-surface',
    title: 'text-fg',
    Icon: Info,
  },
  success: {
    wrap: 'border-success/35 bg-success-subtle',
    title: 'text-success',
    Icon: CheckCircle2,
  },
  warning: {
    wrap: 'border-line bg-panel',
    title: 'text-fg',
    Icon: AlertTriangle,
  },
  error: {
    wrap: 'border-danger/35 bg-danger-subtle',
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
    <div className={`rounded-lg border px-3.5 py-3 ${wrap} ${className}`} role={tone === 'error' ? 'alert' : undefined}>
      {title ? (
        <div className={`flex items-center gap-2 text-[13px] font-medium ${titleColor}`}>
          <Icon size={14} strokeWidth={2} className="shrink-0" />
          {title}
        </div>
      ) : null}
      <div className={`${title ? 'mt-1.5 pl-[22px]' : ''} text-xs leading-6 text-fg-muted`}>{children}</div>
      {action ? <div className={`mt-2.5 ${title ? 'pl-[22px]' : ''}`}>{action}</div> : null}
    </div>
  );
}
