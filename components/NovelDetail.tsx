'use client';

import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type NovelDNACard } from '../app/db';
import { useAppStore } from '../app/store';
import { ensureLlmConfigReady } from '../app/llmClient';
import { runDnaExtraction } from '../app/dnaEngine';
import { getLlmReadinessSummary } from '../app/workflow';

const DNA_FIELDS: { key: keyof NovelDNACard; label: string }[] = [
  { key: 'theme', label: '母题' },
  { key: 'worldview', label: '世界观' },
  { key: 'characters', label: '角色' },
  { key: 'narrativeStyle', label: '叙事' },
  { key: 'styleFingerprint', label: '风格' },
];

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万字`;
  return `${count}字`;
}

export default function NovelDetail({ novelId }: { novelId: string }) {
  const { 
    llmConfig, 
    setManageMode, 
    setWorkshopOpen,
    sequencingGear,
    setSequencingGear,
    setShouldReduceEarly
  } = useAppStore((state) => ({
    llmConfig: state.llmConfig,
    setManageMode: state.setManageMode,
    setWorkshopOpen: state.setWorkshopOpen,
    sequencingGear: state.sequencingGear,
    setSequencingGear: state.setSequencingGear,
    setShouldReduceEarly: state.setShouldReduceEarly
  }));

  const novel = useLiveQuery(() => db.novels.get(novelId), [novelId]);
  const chapters = useLiveQuery(() => db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex'), [novelId]) || [];
  const readyNovelCount = useLiveQuery(() => db.novels.filter((item) => item.analysisStatus === 'done' && Boolean(item.dnaCard)).count(), []) || 0;

  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<keyof NovelDNACard | null>(null);
  const [draft, setDraft] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  if (!novel) {
    return <div className="text-secondary">加载中...</div>;
  }

  const llmReadiness = getLlmReadinessSummary(llmConfig);
  const progress = novel.mapProgress || { total: 0, current: 0 };
  const status = novel.analysisStatus;
  const busy = extracting || status === 'mapping' || status === 'reducing';
  const dnaReady = status === 'done' && novel.dnaCard;

  const handleExtract = async (limit?: number) => {
    const readiness = ensureLlmConfigReady(llmConfig);
    if (!readiness.ok) {
      window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }));
      return;
    }
    setError(null);
    setExtracting(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runDnaExtraction(novelId, { limit, signal: controller.signal });
    } catch (err) {
      setError(err instanceof Error ? err.message : '提取失败');
    } finally {
      setExtracting(false);
      abortRef.current = null;
    }
  };

  const pause = () => abortRef.current?.abort();

  const handleReduceEarly = () => {
    if (progress.current === 0) {
      setError('请至少等待一个章节测序完成，再进行阶段汇总。');
      return;
    }
    setShouldReduceEarly(true);
  };

  const saveField = async (key: keyof NovelDNACard) => {
    if (!novel.dnaCard) return;
    await db.novels.update(novelId, { dnaCard: { ...novel.dnaCard, [key]: draft } });
    setEditKey(null);
  };

  const gearOptions = [
    { id: 'safe', label: '稳健档', speed: '1x', desc: '单轨慢频，绝对控温' },
    { id: 'balanced', label: '均衡档', speed: '3x', desc: '三轨并发，高效首选' },
    { id: 'speed', label: '疾风档', speed: '8x', desc: '八轨全开，超凡拉满' },
  ] as const;

  return (
    <div className="max-w-3xl space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between border-b border-zinc-800 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">{novel.name}</h1>
          <p className="mt-1 text-sm text-secondary">
            {formatWordCount(novel.wordCount)} · {chapters.length}章
          </p>
        </div>
        <button 
          onClick={() => setManageMode(true)} 
          className="text-xs px-3 py-1.5 rounded bg-zinc-900 border border-zinc-800 text-secondary hover:text-white hover:border-zinc-700 transition-all shadow-sm"
        >
          章节微调裁切 ✂️
        </button>
      </div>

      {/* DNA Ready */}
      {dnaReady ? (
        <div className="space-y-6">
          <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
            <span className="flex items-center gap-2 text-sm text-emerald-400 font-medium">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              DNA 基因组图谱已固化就绪
            </span>
            {readyNovelCount >= 2 && (
              <button 
                onClick={() => setWorkshopOpen(true)} 
                className="text-xs px-3 py-1.5 rounded bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-medium shadow-lg hover:shadow-indigo-500/10 transition-all duration-300"
              >
                进入双星融合工坊 →
              </button>
            )}
          </div>

          {DNA_FIELDS.map(({ key, label }) => (
            <div key={key} className="border-b border-zinc-900 pb-6 group">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted font-semibold tracking-wider uppercase">{label}</span>
                {editKey !== key && (
                  <button
                    onClick={() => { setEditKey(key); setDraft(novel.dnaCard?.[key] || ''); }}
                    className="text-xs text-muted hover:text-secondary opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    修改微调
                  </button>
                )}
              </div>
              {editKey === key ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={4}
                    className="w-full rounded border border-zinc-800 bg-zinc-950/80 p-3 text-sm text-white focus:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all font-sans"
                  />
                  <div className="flex gap-3 text-xs justify-end">
                    <button 
                      onClick={() => setEditKey(null)} 
                      className="px-3 py-1.5 rounded border border-zinc-800 text-secondary hover:text-white transition-colors"
                    >
                      取消
                    </button>
                    <button 
                      onClick={() => void saveField(key)} 
                      className="px-3 py-1.5 rounded bg-zinc-100 text-zinc-950 hover:bg-white font-medium transition-colors"
                    >
                      保存更改
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-secondary leading-relaxed whitespace-pre-wrap">
                  {novel.dnaCard?.[key] || '—'}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : (
        /* Extraction View */
        <div className="space-y-8">
          {!llmReadiness.ok && (
            <div className="border border-amber-500/20 bg-amber-500/5 rounded-lg p-4 text-sm max-w-xl">
              <div className="flex items-center gap-2 text-amber-400 font-semibold">
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                模型水晶卡能量未激活
              </div>
              <p className="mt-2 text-secondary text-xs leading-relaxed">{llmReadiness.reason}</p>
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }))}
                className="mt-3 text-xs inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 font-medium transition-colors"
              >
                前往配置 AI 水晶卡密钥 →
              </button>
            </div>
          )}

          {busy && (
            <div className="border border-zinc-800/80 bg-zinc-950/40 rounded-xl p-6 shadow-2xl relative overflow-hidden max-w-xl mx-auto space-y-6">
              {/* Dynamic 0-CPU 3D Rotating Double Helix SVG */}
              <div className="py-4 relative flex justify-center items-center">
                <svg width="180" height="120" viewBox="0 0 180 120" className="select-none overflow-visible">
                  <style>{`
                    @keyframes orbit-a {
                      0%, 100% { transform: translate3d(-35px, 0, 0) scale(0.7); opacity: 0.4; fill: #5e6ad2; }
                      50% { transform: translate3d(35px, 0, 0) scale(1.3); opacity: 1; fill: #06b6d4; }
                    }
                    @keyframes orbit-b {
                      0%, 100% { transform: translate3d(35px, 0, 0) scale(1.3); opacity: 1; fill: #06b6d4; }
                      50% { transform: translate3d(-35px, 0, 0) scale(0.7); opacity: 0.4; fill: #5e6ad2; }
                    }
                    @keyframes line-scale {
                      0%, 50%, 100% { transform: scaleX(0.2); opacity: 0.3; }
                      25% { transform: scaleX(1); opacity: 0.8; }
                      75% { transform: scaleX(1); opacity: 0.8; }
                    }
                    .helix-dot-a { animation: orbit-a 2.5s ease-in-out infinite; transform-origin: center; will-change: transform; }
                    .helix-dot-b { animation: orbit-b 2.5s ease-in-out infinite; transform-origin: center; will-change: transform; }
                    .helix-bar { animation: line-scale 2.5s ease-in-out infinite; transform-origin: center; will-change: transform; }
                  `}</style>
                  <g transform="translate(90, 0)">
                    {Array.from({ length: 8 }).map((_, idx) => {
                      const y = 15 + idx * 13;
                      const delay = `${idx * -0.35}s`;
                      return (
                        <g key={idx} transform={`translate(0, ${y})`} className="overflow-visible">
                          <line x1="-35" y1="0" x2="35" y2="0" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
                          <line x1="-35" y1="0" x2="35" y2="0" stroke="url(#barGradient)" strokeWidth="2" className="helix-bar" style={{ animationDelay: delay }} />
                          <circle cx="0" cy="0" r="4.5" className="helix-dot-a" style={{ animationDelay: delay }} />
                          <circle cx="0" cy="0" r="4.5" className="helix-dot-b" style={{ animationDelay: delay }} />
                        </g>
                      );
                    })}
                  </g>
                  <defs>
                    <linearGradient id="barGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#5e6ad2" />
                      <stop offset="100%" stopColor="#06b6d4" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>

              {/* Progress Text */}
              <div className="space-y-2 text-center">
                <h3 className="text-sm font-semibold tracking-wide text-zinc-100">
                  {status === 'reducing' ? '🧬 凝聚全书五维 DNA 终章结晶...' : `🧬 正在测序小说基因图谱 ${progress.current}/${progress.total || chapters.length}`}
                </h3>
                {status !== 'reducing' && (
                  <p className="text-xs text-muted">
                    已分析章节的精髓正持续汇入本地索引库...
                  </p>
                )}
              </div>

              {/* Glowing Progress Bar */}
              <div className="space-y-1">
                <div className="h-1 bg-zinc-900 rounded-full overflow-hidden relative border border-zinc-800/20">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 transition-all duration-300 rounded-full shadow-[0_0_8px_rgba(6,182,212,0.4)]"
                    style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : status === 'reducing' ? 100 : 0}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted font-mono px-0.5">
                  <span>START</span>
                  <span>{progress.total ? Math.round((progress.current / progress.total) * 100) : 0}%</span>
                  <span>COMPLETE</span>
                </div>
              </div>

              {/* Physical Pause / Stage Summary Controls */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  onClick={pause}
                  className="flex items-center justify-center gap-1.5 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 hover:border-zinc-700 text-xs text-secondary hover:text-white font-medium shadow-sm transition-all"
                >
                  <span>⏸️</span> 暂停测序
                </button>
                <button
                  onClick={handleReduceEarly}
                  disabled={progress.current === 0 || status === 'reducing'}
                  className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold shadow-sm transition-all border ${
                    progress.current === 0 || status === 'reducing'
                      ? 'bg-zinc-950/20 border-zinc-900/50 text-zinc-700 cursor-not-allowed'
                      : 'bg-gradient-to-r from-zinc-800 to-zinc-900 hover:from-zinc-750 hover:to-zinc-850 border-zinc-700/60 hover:border-zinc-600 text-secondary hover:text-white'
                  }`}
                  title={progress.current === 0 ? '需要至少成功分析 1 章方可提前汇总' : '生成已分析章节的临时 DNA 报告'}
                >
                  <span>⏹️</span> 阶段汇总
                </button>
              </div>
            </div>
          )}

          {/* Speed Dial Component (Visible both before and during extraction) */}
          {llmReadiness.ok && (
            <div className="max-w-xl mx-auto space-y-3 border border-zinc-850 bg-zinc-950/20 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-300 tracking-wide flex items-center gap-1.5">
                  <span>⚙️</span> 测序档速拨码器 (实时生效)
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">
                  ACTIVE CONCURRENCY: {sequencingGear === 'safe' ? '1' : sequencingGear === 'speed' ? '8' : '3'} THREADS
                </span>
              </div>
              
              {/* Segmented Control Dial */}
              <div className="bg-zinc-950/80 border border-zinc-900 p-1 rounded-lg flex gap-1 relative">
                {gearOptions.map((opt) => {
                  const isActive = sequencingGear === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setSequencingGear(opt.id)}
                      className={`flex-1 py-2 px-1 rounded-md flex flex-col items-center justify-center cursor-pointer transition-all duration-300 relative z-10 select-none ${
                        isActive 
                          ? 'bg-gradient-to-b from-zinc-800 to-zinc-900 border border-zinc-700/40 text-white shadow-md' 
                          : 'border border-transparent text-secondary hover:text-zinc-300 hover:bg-zinc-900/30'
                      }`}
                    >
                      <span className="text-xs font-bold">{opt.label}</span>
                      <span className={`text-[10px] mt-0.5 font-mono ${
                        isActive
                          ? opt.id === 'speed'
                            ? 'text-cyan-400 font-bold'
                            : opt.id === 'safe'
                            ? 'text-emerald-400 font-bold'
                            : 'text-violet-400 font-bold'
                          : 'text-zinc-500'
                      }`}>
                        {opt.speed} 并发
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Helper text based on active gear */}
              <p className="text-[11px] text-muted leading-relaxed pl-1">
                {gearOptions.find((o) => o.id === sequencingGear)?.desc}。可在此测序期间实时平滑拨码换挡，无需暂停。
              </p>
            </div>
          )}

          {!busy && llmReadiness.ok && (
            <div className="flex gap-4 text-sm max-w-xl mx-auto pt-2">
              <button 
                onClick={() => handleExtract(100)} 
                className="flex-1 py-3 rounded-xl border border-zinc-800 bg-zinc-950 hover:bg-zinc-900 text-secondary hover:text-white font-medium text-center shadow-sm transition-all duration-200"
              >
                快速提取 (前100章)
              </button>
              <button 
                onClick={() => handleExtract(undefined)} 
                className="flex-1 py-3 rounded-xl bg-white hover:bg-zinc-100 text-zinc-950 font-semibold text-center shadow-md hover:shadow-lg transition-all duration-200"
              >
                深度全量测序 (全部章节)
              </button>
            </div>
          )}

          {error && (
            <div className="border border-red-500/20 bg-red-500/5 text-red-400 text-xs rounded-lg p-3 max-w-xl mx-auto flex items-start gap-2">
              <span>⚠️</span>
              <p className="flex-1 leading-relaxed">{error}</p>
            </div>
          )}

          <div className="flex gap-8 text-xs text-muted max-w-xl mx-auto justify-center border-t border-zinc-900 pt-5">
            <span>已分析: {chapters.filter((c) => c.mapStatus === 'done').length} 章</span>
            <span>短章 (&lt;500字): {chapters.filter((c) => c.wordCount < 500).length} 章</span>
            <span>长章 (&gt;12000字): {chapters.filter((c) => c.wordCount > 12000).length} 章</span>
          </div>
        </div>
      )}
    </div>
  );
}
