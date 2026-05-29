'use client';

import React, { useEffect, useState } from 'react';
import { useAppStore } from './store';
import NovelUploader from '../components/NovelUploader';
import ContrastBoard from '../components/ContrastBoard';
import FusionEditor from '../components/FusionEditor';
import SettingsPanel from '../components/SettingsPanel';
import { Settings, Sparkles, Columns, Upload, BookOpen } from 'lucide-react';

export default function Home() {
  const { activeTab, setActiveTab } = useAppStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('open-settings-panel', handler);
    return () => window.removeEventListener('open-settings-panel', handler);
  }, []);

  return (
    <main className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col font-sans relative overflow-y-auto lg:overflow-hidden">
      
      {/* Main Glassmorphic Navbar */}
      <header className="bg-zinc-900/40 backdrop-blur-xl border-b border-zinc-800/80 py-4 px-6 md:px-8 sticky top-0 z-40 flex items-center justify-between">
        
        {/* Brand Logo */}
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200">
            <BookOpen className="w-5 h-5 text-zinc-300" />
          </div>
          <div>
            <h1 className="font-black text-base md:text-lg text-zinc-100 tracking-tight">
              小说创意融合与写作助手
            </h1>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Novel Fusion & Generation Assistant</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="hidden md:flex items-center bg-zinc-900/60 border border-zinc-800 rounded-xl p-1 shadow-inner">
          <button
            onClick={() => setActiveTab('upload')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'upload'
                ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            导入与解析库
          </button>

          <button
            onClick={() => setActiveTab('contrast')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'contrast'
                ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <Columns className="w-3.5 h-3.5" />
            横向对比面板
          </button>

          <button
            onClick={() => setActiveTab('fusion')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'fusion'
                ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            创意融合工坊
          </button>
        </nav>

        {/* Settings button */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen(true)}
            className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-750 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-all flex items-center gap-1.5 text-xs font-semibold"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">大模型配置</span>
          </button>
        </div>

      </header>

      {/* Mobile navigation tab buttons */}
      <div className="md:hidden bg-zinc-900/60 backdrop-blur-md border-b border-zinc-800 p-2 flex justify-around">
        <button
          onClick={() => setActiveTab('upload')}
          className={`flex-1 py-2 text-center text-xs font-bold transition-all rounded-lg ${
            activeTab === 'upload' ? 'text-zinc-100 bg-zinc-800 border border-zinc-700' : 'text-zinc-500'
          }`}
        >
          导入解析
        </button>
        <button
          onClick={() => setActiveTab('contrast')}
          className={`flex-1 py-2 text-center text-xs font-bold transition-all rounded-lg ${
            activeTab === 'contrast' ? 'text-zinc-100 bg-zinc-800 border border-zinc-700' : 'text-zinc-500'
          }`}
        >
          横向对比
        </button>
        <button
          onClick={() => setActiveTab('fusion')}
          className={`flex-1 py-2 text-center text-xs font-bold transition-all rounded-lg ${
            activeTab === 'fusion' ? 'text-zinc-100 bg-zinc-800 border border-zinc-700' : 'text-zinc-500'
          }`}
        >
          创意融合
        </button>
      </div>

      {/* Main Workspace Body */}
      <section className="flex-1 max-w-[1400px] w-full mx-auto p-4 md:p-6 flex flex-col min-h-0">
        
        {/* Render Active Tab Content */}
        <div className="flex-1 min-h-0">
          {activeTab === 'upload' && <NovelUploader />}
          {activeTab === 'contrast' && <ContrastBoard />}
          {activeTab === 'fusion' && <FusionEditor />}
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
