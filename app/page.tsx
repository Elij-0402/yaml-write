'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel } from './db';
import { useAppStore } from './store';
import NovelUploader from '../components/NovelUploader';
import NovelDetail from '../components/NovelDetail';
import FusionWorkshop from '../components/FusionWorkshop';
import SettingsPanel from '../components/SettingsPanel';
import { getLlmReadinessSummary } from './workflow';

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`;
  return `${count}`;
}

function getStatus(novel: Novel): string {
  if (novel.analysisStatus === 'done' && novel.dnaCard) return 'ready';
  if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') return 'extracting';
  if (novel.splitStatus === 'needs_review') return 'review';
  return 'pending';
}

export default function Home() {
  const { selectedNovelId, setSelectedNovelId, workshopOpen, setWorkshopOpen, manageMode, setManageMode, llmConfig } =
    useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsIntent, setSettingsIntent] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const novels = useLiveQuery<Novel[]>(() => db.novels.orderBy('createdAt').reverse().toArray(), []) || [];
  const selectedNovel = novels.find((novel) => novel.id === selectedNovelId) || null;

  const readyCount = novels.filter((novel) => novel.analysisStatus === 'done' && novel.dnaCard).length;
  const llmReadiness = useMemo(() => getLlmReadinessSummary(llmConfig), [llmConfig]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{ intent?: string }>;
      setSettingsIntent(custom.detail?.intent || null);
      setSettingsOpen(true);
    };
    window.addEventListener('open-settings-panel', handler as EventListener);
    return () => window.removeEventListener('open-settings-panel', handler as EventListener);
  }, []);

  const deleteNovel = async (id: string) => {
    if (!window.confirm('删除此作品？')) return;
    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(id).delete();
      await db.novels.delete(id);
    });
    if (selectedNovelId === id) {
      setSelectedNovelId(null);
    }
  };

  const currentPath = workshopOpen
    ? '融合工坊'
    : selectedNovel
    ? manageMode
      ? '章节校验'
      : '作品详情'
    : '总览';

  return (
    <main className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden w-56 flex-col border-r lg:flex">
        <div className="flex h-12 items-center border-b px-4">
          <span className="text-sm text-secondary">创作 DNA 工坊</span>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <button
            onClick={() => {
              setSelectedNovelId(null);
              setWorkshopOpen(false);
              setManageMode(false);
            }}
            className="w-full px-4 py-2 text-left text-sm text-secondary hover:text-primary"
          >
            + 导入作品
          </button>

          {novels.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <div className="px-4 pb-2 text-xs text-muted">作品 ({novels.length})</div>
              {novels.map((novel) => {
                const active = !workshopOpen && selectedNovelId === novel.id;
                const status = getStatus(novel);
                return (
                  <div
                    key={novel.id}
                    className={`group relative cursor-pointer px-4 py-2 ${active ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
                  >
                    <div
                      onClick={() => {
                        setSelectedNovelId(novel.id);
                        setWorkshopOpen(false);
                      }}
                      className="flex items-center justify-between"
                    >
                      <span className={`truncate text-sm ${active ? 'text-primary' : 'text-secondary'}`}>
                        {novel.name}
                      </span>
                      <span className="ml-2 text-xs text-muted">
                        {status === 'ready' ? '●' : status === 'extracting' ? '◐' : status === 'review' ? '○' : '·'}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteNovel(novel.id);
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 hover:text-red-400 group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t py-2">
          <button
            onClick={() => setWorkshopOpen(true)}
            className={`w-full px-4 py-2 text-left text-sm ${workshopOpen ? 'text-primary' : 'text-secondary hover:text-primary'}`}
          >
            融合工坊 {readyCount >= 2 && <span className="text-muted">({readyCount})</span>}
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-secondary hover:text-primary"
          >
            <span>设置</span>
            <span className={`text-xs ${llmReadiness.ok ? 'text-emerald-500' : 'text-amber-500'}`}>
              {llmReadiness.ok ? '●' : '○'}
            </span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between border-b px-6">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">{selectedNovel?.name || '工坊'}</span>
            <span className="text-muted">/</span>
            <span>{currentPath}</span>
          </div>
          <span className={`text-xs ${llmReadiness.ok ? 'text-secondary' : 'text-amber-500'}`}>
            {llmReadiness.ok ? 'LLM Ready' : 'LLM Offline'}
          </span>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {workshopOpen ? (
            <FusionWorkshop />
          ) : selectedNovelId && !manageMode ? (
            <NovelDetail novelId={selectedNovelId} />
          ) : selectedNovelId && manageMode ? (
            <NovelUploader />
          ) : (
            <NovelUploader />
          )}
        </div>
      </section>

      <SettingsPanel
        isOpen={settingsOpen}
        returnHint={settingsIntent}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsIntent(null);
        }}
      />
    </main>
  );
}
