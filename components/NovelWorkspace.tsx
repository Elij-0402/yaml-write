'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Dna, Scissors } from 'lucide-react';
import { db } from '../app/db';
import { useAppStore } from '../app/store';
import NovelDetail from './NovelDetail';
import NovelUploader from './NovelUploader';

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count} 字`;
}

export default function NovelWorkspace({ novelId }: { novelId: string }) {
  const { manageMode, setManageMode, setSelectedNovelId } = useAppStore();
  const novel = useLiveQuery(() => db.novels.get(novelId), [novelId]);
  const chapterCount = useLiveQuery(() => db.chapters.where('novelId').equals(novelId).count(), [novelId]) ?? 0;

  const tab = manageMode ? 'chapters' : 'dna';

  return (
    <div className="view-enter flex h-full min-h-0 flex-col">
      {/* 工作区头部：breadcrumb + 标题 + 本地 segmented tabs */}
      <div className="mb-5 shrink-0 space-y-3">
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          <button onClick={() => setSelectedNovelId(null)} className="flex items-center gap-1 hover:text-fg">
            <ChevronLeft size={14} /> 作品库
          </button>
          <span className="text-fg-subtle">/</span>
          <span className="truncate text-fg">{novel?.name || '加载中…'}</span>
          <span className="text-fg-subtle">/</span>
          <span className="text-fg-muted">{tab === 'chapters' ? '章节校验' : 'DNA'}</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-fg">{novel?.name || ''}</h1>
            {novel && (
              <span className="font-mono text-xs tabular-nums text-fg-subtle">
                {formatWordCount(novel.wordCount)} · {chapterCount} 章
              </span>
            )}
          </div>

          <div className="inline-flex rounded-md border border-line bg-panel p-0.5" role="tablist" aria-label="作品视图">
            <button
              role="tab"
              aria-selected={tab === 'dna'}
              onClick={() => setManageMode(false)}
              className={`flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === 'dna' ? 'bg-surface text-fg shadow-pop' : 'text-fg-muted hover:text-fg'
              }`}
            >
              <Dna size={14} /> DNA
            </button>
            <button
              role="tab"
              aria-selected={tab === 'chapters'}
              onClick={() => setManageMode(true)}
              className={`flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === 'chapters' ? 'bg-surface text-fg shadow-pop' : 'text-fg-muted hover:text-fg'
              }`}
            >
              <Scissors size={14} /> 章节校验
            </button>
          </div>
        </div>
      </div>

      {/* 内容：DNA 板 / 章节校验台。章节台自管高度（flex-1 min-h-0）。 */}
      <div className="min-h-0 flex-1">
        {tab === 'chapters' ? <NovelUploader /> : <NovelDetail novelId={novelId} />}
      </div>
    </div>
  );
}
