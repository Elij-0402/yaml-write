'use client';

import { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type NovelDNACard } from '../app/db';
import { useAppStore } from '../app/store';
import { ensureLlmConfigReady } from '../app/llmClient';
import { runDnaExtraction } from '../app/dnaEngine';
import { Sparkles, Loader2, Search, Scissors, Check, Pencil, Zap, BookOpen, Pause } from 'lucide-react';

const DNA_FIELDS: { key: keyof NovelDNACard; label: string }[] = [
  { key: 'theme', label: '母题与冲突' },
  { key: 'worldview', label: '世界观规则与代价' },
  { key: 'characters', label: '角色灵魂原型' },
  { key: 'narrativeStyle', label: '叙事结构特征' },
  { key: 'styleFingerprint', label: '风格指纹' },
];

const MAP_DOT: Record<string, string> = {
  pending: 'bg-zinc-600',
  done: 'bg-emerald-500',
  error: 'bg-orange-500',
};

export default function NovelDetail({ novelId }: { novelId: string }) {
  const setManageMode = useAppStore((s) => s.setManageMode);
  const novel = useLiveQuery(() => db.novels.get(novelId), [novelId]);
  const chapters = useLiveQuery(
    () => db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex'),
    [novelId]
  ) || [];

  const [search, setSearch] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<keyof NovelDNACard | null>(null);
  const [draft, setDraft] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  if (!novel) {
    return <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">加载中…</div>;
  }

  const filtered = chapters.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()));
  const progress = novel.mapProgress || { total: 0, current: 0 };
  const status = novel.analysisStatus;
  const busy = extracting || status === 'mapping' || status === 'reducing';
  const dnaReady = status === 'done' && novel.dnaCard;

  const handleExtract = async (limit?: number) => {
    const readiness = ensureLlmConfigReady();
    if (!readiness.ok) {
      window.dispatchEvent(new Event('open-settings-panel'));
      return;
    }
    setError(null);
    setExtracting(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runDnaExtraction(novelId, { limit, signal: controller.signal });
    } catch (err) {
      setError(err instanceof Error ? err.message : '提取失败，请重试。');
    } finally {
      setExtracting(false);
      abortRef.current = null;
    }
  };

  const pause = () => abortRef.current?.abort();

  const saveField = async (key: keyof NovelDNACard) => {
    if (!novel.dnaCard) return;
    await db.novels.update(novelId, { dnaCard: { ...novel.dnaCard, [key]: draft } });
    setEditKey(null);
  };

  return (
    <div className="flex-1 flex gap-4 min-h-0 animate-fade-in">
      {/* Left: chapter list */}
      <div className="w-[30%] min-w-[220px] flex flex-col linear-card rounded-lg overflow-hidden">
        <div className="p-3 linear-border-b flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200 truncate">{novel.name}</h2>
            <button
              onClick={() => setManageMode(true)}
              className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded hover:bg-zinc-800/60 transition-linear active-press shrink-0"
              title="管理章节 / 重新切分"
            >
              <Scissors className="w-3.5 h-3.5" /> 重切
            </button>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索章节…"
              className="w-full bg-zinc-900/60 border border-zinc-800 rounded text-xs text-zinc-200 pl-8 pr-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500/30 transition-linear"
            />
          </div>
          <div className="text-[10px] font-mono text-zinc-500">{chapters.length} 章 · 已解析 {progress.current}/{progress.total || chapters.length}</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map((c) => (
            <div key={c.id} className="flex items-center gap-2.5 px-3 py-2 border-b border-zinc-900/60 hover:bg-zinc-900/40 transition-linear">
              {c.mapStatus === 'mapping' ? (
                <Loader2 className="w-3 h-3 text-amber-400 animate-spin shrink-0" />
              ) : (
                <span className={`w-2 h-2 rounded-full shrink-0 ${MAP_DOT[c.mapStatus] || 'bg-zinc-600'}`} />
              )}
              <span className="text-xs text-zinc-300 truncate flex-1">{c.name}</span>
              <span className="text-[10px] font-mono text-zinc-600 shrink-0">{c.wordCount}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: DNA board */}
      <div className="flex-1 min-w-0 overflow-y-auto flex flex-col min-h-0">
        {!dnaReady ? (
          <div className="flex-1 flex items-center justify-center p-6 min-h-0">
            <div className="dna-breathe linear-card rounded-xl p-8 max-w-xl text-center flex flex-col items-center gap-5">
              <div className="p-3 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400">
                <Sparkles className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-zinc-100 mb-2">提取此小说的核心创作 DNA</h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  通过 Map-Reduce 对全书进行底层母题与世界观规则的深度解构，为变体融合提供最纯粹的灵感底物。
                </p>
              </div>

              {busy ? (
                <div className="w-full flex flex-col gap-3">
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-500 transition-all duration-300"
                      style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : status === 'reducing' ? 100 : 0}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-center gap-2 text-[11px] font-mono text-zinc-400">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {status === 'reducing' ? '正在提炼全书 DNA…' : `Mapping ${progress.current}/${progress.total}`}
                  </div>
                  <button
                    onClick={pause}
                    className="mx-auto flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded border border-zinc-800 hover:bg-zinc-800/60 transition-linear active-press"
                  >
                    <Pause className="w-3 h-3" /> 暂停
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 w-full">
                  {error && <p className="text-[11px] text-orange-400">{error}</p>}
                  <div className="flex gap-2.5 justify-center">
                    <button
                      onClick={() => handleExtract(100)}
                      className="flex items-center gap-2 text-xs font-medium px-4 py-2.5 rounded bg-amber-500/90 hover:bg-amber-500 text-zinc-950 transition-linear active-press"
                    >
                      <Zap className="w-3.5 h-3.5" /> {status === 'error' ? '继续提取' : '全速提取（前100章）'}
                    </button>
                    <button
                      onClick={() => handleExtract(undefined)}
                      className="flex items-center gap-2 text-xs font-medium px-4 py-2.5 rounded border border-zinc-700 hover:bg-zinc-800/60 text-zinc-200 transition-linear active-press"
                    >
                      <BookOpen className="w-3.5 h-3.5" /> 深度全量提取
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-1">
            {DNA_FIELDS.map(({ key, label }) => (
              <div key={key} className="group linear-card rounded-lg p-4 relative transition-linear">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] uppercase font-mono tracking-widest text-amber-500/80">{label}</span>
                  {editKey === key ? (
                    <button onClick={() => saveField(key)} className="text-emerald-400 hover:text-emerald-300 active-press" title="保存">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => { setEditKey(key); setDraft(novel.dnaCard?.[key] ?? ''); }}
                      className="text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-amber-400 transition-linear active-press"
                      title="编辑"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {editKey === key ? (
                  <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={4}
                    className="w-full bg-zinc-900/80 border border-amber-500/30 rounded text-sm text-zinc-200 p-2 leading-relaxed focus:outline-none resize-y"
                  />
                ) : (
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{novel.dnaCard?.[key]}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
