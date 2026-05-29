'use client';

import React, { useEffect, useState } from 'react';
import { useAppStore } from './store';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel } from './db';
import NovelUploader from '../components/NovelUploader';
import ContrastBoard from '../components/ContrastBoard';
import FusionEditor from '../components/FusionEditor';
import SettingsPanel from '../components/SettingsPanel';
import { 
  Settings, 
  Columns, 
  Upload, 
  BookOpen, 
  ChevronLeft, 
  ChevronRight, 
  FolderOpen, 
  Layers, 
  Sparkles,
  BookMarked
} from 'lucide-react';

export default function Home() {
  const { 
    activeTab, 
    setActiveTab, 
    selectedNovelId, 
    setSelectedNovelId,
    llmConfig 
  } = useAppStore();
  
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Fetch novels for the sidebar switcher
  const novels = useLiveQuery<Novel[]>(() => db.novels.reverse().toArray(), []) || [];
  const selectedNovel = novels.find(n => n.id === selectedNovelId) || null;

  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('open-settings-panel', handler);
    return () => window.removeEventListener('open-settings-panel', handler);
  }, []);

  // Format word count
  const formatWordCount = (count: number) => {
    if (count >= 10000) {
      return `${(count / 10000).toFixed(1)}万字`;
    }
    return `${count}字`;
  };

  return (
    <main className="min-h-screen bg-[#0c0c0e] text-zinc-100 flex font-sans overflow-hidden">
      
      {/* Linear Left Sidebar */}
      <aside 
        className={`bg-[#08080a] linear-border-r flex flex-col transition-all duration-300 z-30 select-none relative ${
          sidebarCollapsed ? 'w-[64px]' : 'w-[260px]'
        }`}
      >
        {/* Sidebar Header */}
        <div className="h-[60px] linear-border-b px-4 flex items-center justify-between">
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2.5 animate-fade-in">
              <div className="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-amber-500">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <h1 className="font-semibold text-sm tracking-tight text-zinc-200">
                  小说解析与写作
                </h1>
                <p className="text-[9px] text-zinc-500 font-mono tracking-wider uppercase">FUSION ASSISTANT</p>
              </div>
            </div>
          )}
          {sidebarCollapsed && (
            <div className="mx-auto p-1.5 rounded bg-zinc-900 border border-zinc-800 text-amber-500">
              <Sparkles className="w-4 h-4" />
            </div>
          )}
          
          {/* Collapse Trigger Button - Floating style */}
          {!sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="p-1 rounded hover:bg-zinc-900 border border-transparent hover:border-zinc-800 text-zinc-400 hover:text-zinc-200 active-press transition-linear"
              title="折叠边栏"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Sidebar Navigation */}
        <div className="flex-1 py-4 flex flex-col gap-6 overflow-y-auto px-3">
          
          {/* 1. Novel Workspace Switcher */}
          {!sidebarCollapsed && (
            <div className="flex flex-col gap-1.5 animate-fade-in">
              <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-500 px-2">当前小说</span>
              <div className="relative group">
                <select
                  value={selectedNovelId || ''}
                  onChange={(e) => setSelectedNovelId(e.target.value || null)}
                  className="w-full bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 text-zinc-200 text-xs rounded px-3 py-2.5 pr-8 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-amber-500/30 transition-linear"
                >
                  <option value="" className="bg-[#121214] text-zinc-400">选择小说 workspace...</option>
                  {novels.map((novel) => (
                    <option key={novel.id} value={novel.id} className="bg-[#121214] text-zinc-200">
                      {novel.name} ({formatWordCount(novel.wordCount)})
                    </option>
                  ))}
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-500 group-hover:text-zinc-300 transition-linear">
                  <FolderOpen className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>
          )}

          {/* 2. Page Navigation Options */}
          <div className="flex flex-col gap-1">
            {!sidebarCollapsed && (
              <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-500 px-2 mb-1.5">核心工作区</span>
            )}
            
            <button
              onClick={() => setActiveTab('upload')}
              className={`flex items-center gap-3 px-3 py-2.5 rounded text-xs font-medium transition-linear active-press ${
                activeTab === 'upload'
                  ? 'bg-zinc-900 border border-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/40'
              } ${sidebarCollapsed ? 'justify-center' : ''}`}
              title="导入与解析库"
            >
              <Upload className="w-4 h-4 text-zinc-400" />
              {!sidebarCollapsed && <span className="truncate">导入与解析库</span>}
            </button>

            <button
              onClick={() => setActiveTab('contrast')}
              className={`flex items-center gap-3 px-3 py-2.5 rounded text-xs font-medium transition-linear active-press ${
                activeTab === 'contrast'
                  ? 'bg-zinc-900 border border-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/40'
              } ${sidebarCollapsed ? 'justify-center' : ''}`}
              title="横向对比面板"
            >
              <Columns className="w-4 h-4 text-zinc-400" />
              {!sidebarCollapsed && <span className="truncate">横向对比面板</span>}
            </button>

            <button
              onClick={() => setActiveTab('fusion')}
              className={`flex items-center gap-3 px-3 py-2.5 rounded text-xs font-medium transition-linear active-press ${
                activeTab === 'fusion'
                  ? 'bg-zinc-900 border border-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/40'
              } ${sidebarCollapsed ? 'justify-center' : ''}`}
              title="创意融合工坊"
            >
              <BookOpen className="w-4 h-4 text-zinc-400" />
              {!sidebarCollapsed && <span className="truncate">创意融合工坊</span>}
            </button>
          </div>

        </div>

        {/* Sidebar Footer */}
        <div className="linear-border-t p-3 flex flex-col gap-2 bg-[#060608]">
          {/* Active Model Tiny Indicator */}
          {!sidebarCollapsed && (
            <div className="bg-zinc-950 border border-zinc-900 rounded p-2 flex items-center justify-between gap-2 text-[10px] font-mono text-zinc-500 animate-fade-in">
              <span className="truncate">大模型: <span className="text-zinc-300 font-sans">{llmConfig.activeProvider.toUpperCase()}</span></span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="inline-flex rounded-full h-1.5 w-1.5 bg-zinc-600"></span>
                <span className="text-zinc-400">就绪</span>
              </div>
            </div>
          )}

          {/* Settings button */}
          <button
            onClick={() => setSettingsOpen(true)}
            className={`w-full py-2 px-3 rounded bg-zinc-900/80 hover:bg-zinc-900 border border-zinc-850 hover:border-zinc-750 text-zinc-400 hover:text-zinc-200 transition-linear active-press flex items-center gap-2.5 text-xs font-medium ${
              sidebarCollapsed ? 'justify-center' : ''
            }`}
            title="大模型配置"
          >
            <Settings className="w-4 h-4 shrink-0 text-zinc-400" />
            {!sidebarCollapsed && <span className="truncate">大模型配置</span>}
          </button>
        </div>

      </aside>

      {/* Main Workspace Area */}
      <section className="flex-1 flex flex-col min-w-0 bg-[#0c0c0e] relative overflow-hidden">
        
        {/* Elegant Top Header / Breadcrumbs */}
        <header className="h-[60px] linear-border-b px-6 flex items-center justify-between bg-[#0c0c0e]/80 backdrop-blur-md z-20 shrink-0">
          <div className="flex items-center gap-3">
            {sidebarCollapsed && (
              <button
                onClick={() => setSidebarCollapsed(false)}
                className="p-1 rounded hover:bg-zinc-900 border border-transparent hover:border-zinc-800 text-zinc-400 hover:text-zinc-200 active-press transition-linear mr-1"
                title="展开边栏"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
            
            {/* Minimalist breadcrumb */}
            <div className="flex items-center gap-2 text-xs text-zinc-500 font-medium">
              <span className="text-zinc-400 font-semibold flex items-center gap-1.5">
                <BookMarked className="w-3.5 h-3.5 text-zinc-500" />
                {selectedNovel ? selectedNovel.name : '主空间'}
              </span>
              <span className="text-zinc-700">/</span>
              <span className="text-zinc-300">
                {activeTab === 'upload' && '导入与解析库'}
                {activeTab === 'contrast' && '横向对比面板'}
                {activeTab === 'fusion' && '创意融合工坊'}
              </span>
            </div>
          </div>

          {/* Right Header Status details if any */}
          {selectedNovel && (
            <div className="hidden sm:flex items-center gap-3 text-[11px] text-zinc-500 font-mono">
              <span>总字数: {selectedNovel.wordCount.toLocaleString()} 字</span>
              {selectedNovel.purifiedCount && selectedNovel.purifiedCount > 0 ? (
                <>
                  <span className="text-zinc-700">|</span>
                  <span>已过滤广告: {selectedNovel.purifiedCount} 字符</span>
                </>
              ) : null}
            </div>
          )}
        </header>

        {/* Content Panel */}
        <div className="flex-1 overflow-y-auto min-h-0 p-6 md:p-8 flex flex-col">
          <div className="flex-1 flex flex-col w-full max-w-[1500px] mx-auto min-h-0 animate-fade-in">
            {activeTab === 'upload' && <NovelUploader />}
            {activeTab === 'contrast' && <ContrastBoard />}
            {activeTab === 'fusion' && <FusionEditor />}
          </div>
        </div>

      </section>

      {/* Slide-out settings config drawer */}
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

    </main>
  );
}
