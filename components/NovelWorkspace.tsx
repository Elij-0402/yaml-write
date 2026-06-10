'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { Dna, Scissors } from 'lucide-react';
import { db } from '../app/db';
import { useAppStore } from '../app/store';
import NovelDetail from './NovelDetail';
import NovelUploader from './NovelUploader';

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count} 字`;
}

// 单本作品工作区：标题 + mono 计量 + 分段 tab（DNA / 章节校验）。面包屑由全局顶栏负责。
export default function NovelWorkspace({ novelId }: { novelId: string }) {
  const { manageMode, setManageMode } = useAppStore();
  const novel = useLiveQuery(() => db.novels.get(novelId), [novelId]);
  const chapterCount = useLiveQuery(() => db.chapters.where('novelId').equals(novelId).count(), [novelId]) ?? 0;

  const tab = manageMode ? 'chapters' : 'dna';

  return (
    <div className="view-enter flex h-full min-h-0 flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="truncate text-base font-semibold text-fg">{novel?.name || '加载中…'}</h1>
          {novel && (
            <span className="shrink-0 font-mono text-xs tabular-nums text-fg-subtle">
              {formatWordCount(novel.wordCount)} · {chapterCount} 章
            </span>
          )}
        </div>

        <div className="seg shrink-0" role="tablist" aria-label="作品视图">
          <button
            role="tab"
            aria-selected={tab === 'dna'}
            onClick={() => setManageMode(false)}
            className="seg-item"
          >
            <Dna size={13} /> DNA
          </button>
          <button
            role="tab"
            aria-selected={tab === 'chapters'}
            onClick={() => setManageMode(true)}
            className="seg-item"
          >
            <Scissors size={13} /> 章节校验
          </button>
        </div>
      </div>

      {/* 内容：DNA 板 / 章节校验台。章节台自管高度（flex-1 min-h-0）。 */}
      <div className="min-h-0 flex-1">
        {tab === 'chapters' ? <NovelUploader /> : <NovelDetail novelId={novelId} />}
      </div>
    </div>
  );
}
