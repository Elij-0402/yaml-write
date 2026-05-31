'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ChevronRight,
  FilePlus2,
  Layers,
  Settings,
  Trash2,
} from 'lucide-react';
import { db, type Novel } from './db';
import { useAppStore } from './store';
import NovelUploader from '../components/NovelUploader';
import NovelDetail from '../components/NovelDetail';
import FusionWorkshop from '../components/FusionWorkshop';
import SettingsPanel from '../components/SettingsPanel';
import { getLlmReadinessSummary, getNovelWorkflowSummary } from './workflow';

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count} 字`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(timestamp);
}

function dnaBadge(novel: Novel): { text: string; ready: boolean } {
  if (novel.analysisStatus === 'done' && novel.dnaCard) {
    return { text: 'DNA 就绪', ready: true };
  }
  if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') {
    const p = novel.mapProgress;
    const pct = p && p.total ? Math.round((p.current / p.total) * 100) : 0;
    return { text: `提取中 ${pct}%`, ready: false };
  }
  if (novel.splitStatus === 'needs_review') {
    return { text: '待校验', ready: false };
  }
  return { text: '待提取', ready: false };
}

function Overview({
  novels,
  readyCount,
  llmReady,
  onUpload,
  onContinue,
}: {
  novels: Novel[];
  readyCount: number;
  llmReady: boolean;
  onUpload: () => void;
  onContinue: () => void;
}) {
  const latestNovel = novels[0] || null;

  return (
    <div className="animate-fade-in space-y-8">
      {/* Hero */}
      <div className="space-y-3">
        <p className="text-xs text-muted">创作 DNA 工坊</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          从长篇小说提炼创作骨架
        </h1>
        <p className="text-sm text-secondary max-w-xl leading-relaxed">
          导入 TXT 原文，自动切分章节、提取 DNA 特征，支持多作品融合创作。
        </p>
      </div>

      {/* Actions */}
      <div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
        <button
          onClick={onUpload}
          className="group flex items-center justify-between rounded-lg border border-subtle bg-card p-4 text-left transition-base hover:border-visible"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">导入新作品</p>
            <p className="text-xs text-muted">上传 TXT 文件开始处理</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted transition-base group-hover:text-primary" />
        </button>

        <button
          onClick={onContinue}
          disabled={!latestNovel}
          className="group flex items-center justify-between rounded-lg border border-subtle bg-card p-4 text-left transition-base hover:border-visible disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">继续最近作品</p>
            <p className="text-xs text-muted truncate max-w-[180px]">
              {latestNovel ? `《${latestNovel.name}》` : '暂无作品'}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted transition-base group-hover:text-primary" />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 max-w-2xl">
        <div className="space-y-1 rounded-lg border border-subtle p-4">
          <p className="text-2xl font-medium">{novels.length}</p>
          <p className="text-xs text-muted">作品库存</p>
        </div>
        <div className="space-y-1 rounded-lg border border-subtle p-4">
          <p className="text-2xl font-medium">{readyCount}</p>
          <p className="text-xs text-muted">DNA 就绪</p>
        </div>
        <div className="space-y-1 rounded-lg border border-subtle p-4">
          <p className="text-2xl font-medium">{novels.filter(n => n.splitStatus === 'needs_review').length}</p>
          <p className="text-xs text-muted">待校验</p>
        </div>
        <div className="space-y-1 rounded-lg border border-subtle p-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${llmReady ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <p className="text-sm font-medium">{llmReady ? '就绪' : '离线'}</p>
          </div>
          <p className="text-xs text-muted">模型引擎</p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { selectedNovelId, setSelectedNovelId, workshopOpen, setWorkshopOpen, manageMode, setManageMode, llmConfig } =
    useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsIntent, setSettingsIntent] = useState<string | null>(null);
  const [showUploader, setShowUploader] = useState(false);

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

  const readyNovelCount = novels.filter((novel) => novel.analysisStatus === 'done' && novel.dnaCard).length;
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

  const deleteNovel = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (!window.confirm('确认删除该作品？')) return;
    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(id).delete();
      await db.novels.delete(id);
    });
    if (selectedNovelId === id) {
      setSelectedNovelId(null);
    }
  };

  const currentView = workshopOpen
    ? '融合工坊'
    : selectedNovel
    ? manageMode
      ? '章节校验'
      : '作品详情'
    : showUploader
    ? '导入作品'
    : '总览';

  return (
    <main className="flex min-h-screen bg-[var(--bg-app)]">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-subtle bg-panel lg:flex">
        {/* Logo */}
        <div className="border-b border-subtle px-4 py-4">
          <h1 className="text-sm font-medium">创作 DNA 工坊</h1>
        </div>

        {/* New Button */}
        <div className="px-3 py-3">
          <button
            onClick={() => {
              setSelectedNovelId(null);
              setWorkshopOpen(false);
              setManageMode(false);
              setShowUploader(true);
            }}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-subtle bg-card px-3 py-2 text-xs font-medium transition-base hover:border-visible"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            导入新原稿
          </button>
        </div>

        {/* Novel List */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <p className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-muted">
            作品列表
          </p>
          <div className="space-y-1">
            {novels.length === 0 && (
              <p className="px-1 py-4 text-xs text-muted">暂无作品</p>
            )}
            {novels.map((novel) => {
              const active = !workshopOpen && selectedNovelId === novel.id;
              const badge = dnaBadge(novel);
              return (
                <button
                  key={novel.id}
                  onClick={() => {
                    setSelectedNovelId(novel.id);
                    setShowUploader(false);
                    setWorkshopOpen(false);
                  }}
                  className={`group relative w-full rounded-md px-3 py-2.5 text-left transition-base ${
                    active
                      ? 'bg-card'
                      : 'hover:bg-card/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{novel.name}</p>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
                        <span>{formatWordCount(novel.wordCount)}</span>
                        <span>·</span>
                        <span>{formatTime(novel.createdAt)}</span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => void deleteNovel(novel.id, e)}
                      className="rounded p-1 text-muted opacity-0 transition-base hover:text-red-400 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${badge.ready ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
                    <span className="text-[10px] text-muted">{badge.text}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Bottom Actions */}
        <div className="border-t border-subtle p-3 space-y-1">
          <button
            onClick={() => setWorkshopOpen(true)}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-base ${
              workshopOpen ? 'bg-card' : 'hover:bg-card/50'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            融合工坊
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-xs font-medium transition-base hover:bg-card/50"
          >
            <span className="flex items-center gap-2">
              <Settings className="h-3.5 w-3.5" />
              设置
            </span>
            <span className={`h-1.5 w-1.5 rounded-full ${llmReadiness.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="sticky top-0 z-10 border-b border-subtle bg-[var(--bg-app)]/80 backdrop-blur-sm">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted">{selectedNovel?.name || '工坊'}</span>
              <span className="text-muted">/</span>
              <span>{currentView}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${llmReadiness.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              <span className="text-xs text-muted">
                {llmReadiness.ok ? '模型就绪' : '模型离线'}
              </span>
            </div>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {workshopOpen ? (
            <FusionWorkshop />
          ) : selectedNovelId && !manageMode ? (
            <NovelDetail novelId={selectedNovelId} />
          ) : selectedNovelId && manageMode ? (
            <NovelUploader />
          ) : showUploader ? (
            <NovelUploader />
          ) : (
            <Overview
              novels={novels}
              readyCount={readyNovelCount}
              llmReady={llmReadiness.ok}
              onUpload={() => setShowUploader(true)}
              onContinue={() => {
                if (!novels[0]) return;
                setSelectedNovelId(novels[0].id);
                setShowUploader(false);
              }}
            />
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
