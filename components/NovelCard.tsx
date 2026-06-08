'use client';

import { X } from 'lucide-react';
import { type Novel } from '../app/db';
import { isDnaReady, isExtracting } from '../app/dnaState';

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count} 字`;
}

type StatusTone = 'live' | 'ready' | 'muted';
function novelStatus(novel: Novel): { label: string; tone: StatusTone } {
  if (isDnaReady(novel)) return { label: 'DNA 就绪', tone: 'ready' };
  if (isExtracting(novel)) return { label: '提取中', tone: 'live' };
  if (novel.splitStatus === 'needs_review') return { label: '待校验', tone: 'muted' };
  return { label: '待处理', tone: 'muted' };
}

// 状态点：提取中=蓝呼吸（唯一「正在发生」）；就绪=绿实心；其余=灰描边。绝不让 idle/就绪抢强调蓝。
function StatusDot({ tone }: { tone: StatusTone }) {
  if (tone === 'live') return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />;
  if (tone === 'ready') return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />;
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-fg-subtle" />;
}

export default function NovelCard({
  novel,
  active,
  onOpen,
  onDelete,
}: {
  novel: Novel;
  active?: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const status = novelStatus(novel);
  return (
    <div
      className={`card group relative cursor-pointer p-4 transition-colors hover:border-fg-subtle ${active ? 'border-accent' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5"><StatusDot tone={status.tone} /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate pr-6 text-sm font-medium text-fg" title={novel.name}>{novel.name}</div>
          <div className="mt-2 flex items-center gap-2">
            <span className="font-mono text-xs tabular-nums text-fg-subtle">{formatWordCount(novel.wordCount)}</span>
            <span
              className={`text-xs ${
                status.tone === 'live' ? 'text-accent' : status.tone === 'ready' ? 'text-success' : 'text-fg-subtle'
              }`}
            >
              · {status.label}
            </span>
          </div>
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle opacity-0 transition hover:bg-raised hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`删除《${novel.name}》`}
      >
        <X size={15} />
      </button>
    </div>
  );
}
