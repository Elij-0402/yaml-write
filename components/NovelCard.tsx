'use client';

import { X } from 'lucide-react';
import { type Novel } from '../app/db';
import { isDnaReady, isExtracting } from '../app/dnaState';
import { formatWordCount } from '../app/util';

type StatusTone = 'live' | 'ready' | 'muted';
function novelStatus(novel: Novel): { label: string; tone: StatusTone } {
  if (isDnaReady(novel)) return { label: 'DNA 就绪', tone: 'ready' };
  if (isExtracting(novel)) return { label: '提取中', tone: 'live' };
  if (novel.splitStatus === 'needs_review') return { label: '待校验', tone: 'muted' };
  return { label: '待处理', tone: 'muted' };
}

// 状态点：提取中=靛蓝呼吸（唯一「正在发生」）；就绪=绿实心；其余=灰描边。idle/就绪绝不抢强调色。
function StatusDot({ tone }: { tone: StatusTone }) {
  if (tone === 'live') return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />;
  if (tone === 'ready') return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />;
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-fg-subtle" />;
}

// 作品行（列表式，宿主容器负责 divide-y / 圆角）：状态点 + 书名 + mono 计量 + hover 删除。
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
      className={`group relative flex h-12 cursor-pointer items-center gap-3 px-4 transition-colors hover:bg-raised ${active ? 'bg-raised' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
    >
      <StatusDot tone={status.tone} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg" title={novel.name}>{novel.name}</span>

      <span className="hidden shrink-0 font-mono text-xs tabular-nums text-fg-subtle sm:inline">{formatWordCount(novel.wordCount)} 字</span>
      <span
        className={`w-16 shrink-0 text-right text-xs ${
          status.tone === 'live' ? 'text-accent-ink' : status.tone === 'ready' ? 'text-success' : 'text-fg-subtle'
        }`}
      >
        {status.label}
      </span>

      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-fg-subtle opacity-0 transition hover:bg-surface hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        aria-label={`删除《${novel.name}》`}
      >
        <X size={14} />
      </button>
    </div>
  );
}
