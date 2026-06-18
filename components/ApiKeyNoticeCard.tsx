'use client';

import React from 'react';
import { KeyRound } from 'lucide-react';

export interface ApiKeyNoticeCardProps {
  onConfigure: () => void;
}

export default function ApiKeyNoticeCard({ onConfigure }: ApiKeyNoticeCardProps) {
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-sm border border-accent/30 bg-accent/5 px-4 py-3"
    >
      <KeyRound size={16} className="mt-0.5 shrink-0 text-accent-ink" />
      <div className="flex-1 text-[13px] leading-relaxed text-fg-muted">
        未检测到 API 密钥，AI 功能暂不可用。
      </div>
      <button
        onClick={onConfigure}
        className="btn btn-primary btn-sm shrink-0 text-xs"
      >
        前往配置密钥
      </button>
    </div>
  );
}