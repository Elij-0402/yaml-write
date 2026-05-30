'use client';

import React, { useEffect, useState } from 'react';
import { useAppStore } from './store';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel } from './db';
import NovelUploader from '../components/NovelUploader';
import NovelDetail from '../components/NovelDetail';
import FusionWorkshop from '../components/FusionWorkshop';
import SettingsPanel from '../components/SettingsPanel';
import { Settings, Upload, Layers, Sparkles, ArrowLeft, BookMarked, Trash2 } from 'lucide-react';

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万字`;
  return `${count}字`;
}

function dnaBadge(novel: Novel): { text: string; cls: string } {
  if (novel.analysisStatus === 'done' && novel.dnaCard) {
    return { text: 'DNA 就绪', cls: 'text-emerald-400' };
  }
  if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') {
    const p = novel.mapProgress;
    const pct = p && p.total ? Math.round((p.current / p.total) * 100) : 0;
    return { text: `进度 ${pct}%`, cls: 'text-amber-400' };
  }
  if (novel.analysisStatus === 'error') return { text: '出错', cls: 'text-orange-400' };
  return { text: '未提取', cls: 'text-zinc-500' };
}

export default function Home() {
  const {
    selectedNovelId,
    setSelectedNovelId,
    workshopOpen,
    setWorkshopOpen,
    manageMode,
    setManageMode,
    llmConfig,
  } = useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);

  const novels = useLiveQuery<Novel[]>(() => db.novels.reverse().toArray(), []) || [];
  const selectedNovel = novels.find((n) => n.id === selectedNovelId) || null;

  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('open-settings-panel', handler);
    return () => window.removeEventListener('open-settings-panel', handler);
  }, []);

  const deleteNovel = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof window !== 'undefined' && !window.confirm('删除该小说及其全部章节？此操作不可撤销。')) return;
    await db.transaction('rw', db.novels, db.chapters, async () => {
      await db.chapters.where('novelId').equals(id).delete();
      await db.novels.delete(id);
    });
    if (selectedNovelId === id) setSelectedNovelId(null);
  };

  const breadcrumb = workshopOpen
    ? '创意融合工坊'
    : selectedNovel
    ? manageMode
      ? '管理章节 / 重新切分'
      : '创作 DNA'
    : '导入新书';

  return (
    <main className="min-h-screen bg-[#0c0c0e] text-zinc-100 flex font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-[260px] bg-[#08080a] linear-border-r flex flex-col z-30 select-none">
        <div className="h-[60px] linear-border-b px-4 flex items-center gap-2.5">
          <div className="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-amber-500">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h1 className="font-semibold text-sm tracking-tight text-zinc-200">创作 DNA 工坊</h1>
            <p className="text-[9px] text-zinc-500 font-mono tracking-wider uppercase">FUSION STUDIO</p>
          </div>
        </div>

        <div className="p-3">
          <button
            onClick={() => setSelectedNovelId(null)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded bg-zinc-900/80 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200 text-xs font-medium transition-linear active-press"
          >
            <Upload className="w-3.5 h-3.5 text-amber-500" /> 上传新书
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3">
          <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-500 px-1">小说库</span>
          <div className="flex flex-col gap-1 mt-2">
            {novels.length === 0 && (
              <p className="text-[11px] text-zinc-600 px-1 py-2">还没有小说，点击「上传新书」开始。</p>
            )}
            {novels.map((novel) => {
              const active = !workshopOpen && selectedNovelId === novel.id;
              const badge = dnaBadge(novel);
              return (
                <div
                  key={novel.id}
                  onClick={() => setSelectedNovelId(novel.id)}
                  className={`group cursor-pointer px-2.5 py-2 rounded transition-linear active-press ${
                    active ? 'bg-zinc-900 border border-zinc-800' : 'border border-transparent hover:bg-zinc-900/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-zinc-200 truncate">{novel.name}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-[9px] font-mono ${badge.cls}`}>{badge.text}</span>
                      <button
                        onClick={(e) => deleteNovel(novel.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-600 hover:text-rose-400 transition-linear"
                        title="删除小说"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-600">{formatWordCount(novel.wordCount)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="linear-border-t p-3 flex flex-col gap-2 bg-[#060608]">
          <button
            onClick={() => setWorkshopOpen(true)}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded text-xs font-medium transition-linear active-press ${
              workshopOpen ? 'bg-amber-500/10 border border-amber-500/30 text-amber-300' : 'bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 text-zinc-200'
            }`}
          >
            <Layers className="w-4 h-4 text-amber-500" /> 创意融合工坊
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-850 hover:border-zinc-750 text-zinc-400 hover:text-zinc-200 transition-linear active-press text-xs font-medium"
          >
            <Settings className="w-4 h-4" /> 大模型配置
            <span className="ml-auto text-[10px] font-mono text-zinc-600">{llmConfig.activeProvider.toUpperCase()}</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <section className="flex-1 flex flex-col min-w-0 bg-[#0c0c0e] relative overflow-hidden">
        <header className="h-[60px] linear-border-b px-6 flex items-center gap-3 bg-[#0c0c0e]/80 backdrop-blur-md z-20 shrink-0">
          {manageMode && selectedNovel && !workshopOpen && (
            <button
              onClick={() => setManageMode(false)}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 transition-linear active-press"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> 返回 DNA
            </button>
          )}
          <div className="flex items-center gap-2 text-xs text-zinc-500 font-medium">
            <span className="text-zinc-400 font-semibold flex items-center gap-1.5">
              <BookMarked className="w-3.5 h-3.5 text-zinc-500" />
              {workshopOpen ? '工坊' : selectedNovel ? selectedNovel.name : '主空间'}
            </span>
            <span className="text-zinc-700">/</span>
            <span className="text-zinc-300">{breadcrumb}</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto min-h-0 p-6 md:p-8 flex flex-col">
          <div className="flex-1 flex flex-col w-full max-w-[1500px] mx-auto min-h-0">
            {workshopOpen ? (
              <FusionWorkshop />
            ) : selectedNovelId && !manageMode ? (
              <NovelDetail novelId={selectedNovelId} />
            ) : (
              <NovelUploader />
            )}
          </div>
        </div>
      </section>

      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </main>
  );
}
