'use client';

import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  Loader2,
  Pause,
  Pencil,
  Scissors,
  Search,
  Zap,
} from 'lucide-react';
import { db, type NovelDNACard } from '../app/db';
import { useAppStore } from '../app/store';
import { ensureLlmConfigReady } from '../app/llmClient';
import { runDnaExtraction } from '../app/dnaEngine';
import { getLlmReadinessSummary, getNovelWorkflowSummary } from '../app/workflow';

const DNA_FIELDS: { key: keyof NovelDNACard; label: string }[] = [
  { key: 'theme', label: '母题与冲突' },
  { key: 'worldview', label: '世界观规则' },
  { key: 'characters', label: '角色原型' },
  { key: 'narrativeStyle', label: '叙事结构' },
  { key: 'styleFingerprint', label: '风格指纹' },
];

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count.toLocaleString()} 字`;
}

export default function NovelDetail({ novelId }: { novelId: string }) {
  const { llmConfig, setManageMode, setWorkshopOpen } = useAppStore((state) => ({
    llmConfig: state.llmConfig,
    setManageMode: state.setManageMode,
    setWorkshopOpen: state.setWorkshopOpen,
  }));

  const novel = useLiveQuery(() => db.novels.get(novelId), [novelId]);
  const chapters =
    useLiveQuery(() => db.chapters.where('novelId').equals(novelId).sortBy('chapterIndex'), [novelId]) || [];
  const readyNovelCount =
    useLiveQuery(
      () =>
        db.novels
          .filter((item) => item.analysisStatus === 'done' && Boolean(item.dnaCard))
          .count(),
      []
    ) || 0;

  const [search, setSearch] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<keyof NovelDNACard | null>(null);
  const [draft, setDraft] = useState('');
  const [showChapters, setShowChapters] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  if (!novel) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        加载中...
      </div>
    );
  }

  const llmReadiness = getLlmReadinessSummary(llmConfig);
  const workflow = getNovelWorkflowSummary(novel, llmConfig, readyNovelCount);
  const filtered = chapters.filter((chapter) => chapter.name.toLowerCase().includes(search.trim().toLowerCase()));
  const progress = novel.mapProgress || { total: 0, current: 0 };
  const status = novel.analysisStatus;
  const busy = extracting || status === 'mapping' || status === 'reducing';
  const dnaReady = status === 'done' && novel.dnaCard;
  const completedChapters = chapters.filter((chapter) => chapter.mapStatus === 'done').length;

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

  const saveField = async (key: keyof NovelDNACard) => {
    if (!novel.dnaCard) return;
    await db.novels.update(novelId, { dnaCard: { ...novel.dnaCard, [key]: draft } });
    setEditKey(null);
  };

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{novel.name}</h1>
          <p className="text-sm text-secondary">
            {formatWordCount(novel.wordCount)} · {chapters.length} 章
          </p>
        </div>
        <button
          onClick={() => setManageMode(true)}
          className="flex items-center gap-2 rounded-md border border-subtle px-3 py-2 text-sm transition-base hover:bg-card"
        >
          <Scissors className="h-4 w-4" />
          章节校验
        </button>
      </div>

      {/* DNA Ready View */}
      {dnaReady ? (
        <div className="space-y-6">
          {/* Success Banner */}
          <div className="flex items-center justify-between rounded-lg border border-emerald-900/30 bg-emerald-950/20 p-4">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-sm">DNA 提取完成</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowChapters(!showChapters)}
                className="rounded-md border border-subtle px-3 py-1.5 text-xs transition-base hover:bg-card"
              >
                {showChapters ? '隐藏章节' : '查看章节'}
              </button>
              {readyNovelCount > 1 && (
                <button
                  onClick={() => setWorkshopOpen(true)}
                  className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-base hover:bg-white/90"
                >
                  进入融合工坊
                </button>
              )}
            </div>
          </div>

          {/* DNA Fields */}
          <div className="space-y-4">
            {DNA_FIELDS.map(({ key, label }) => (
              <div key={key} className="rounded-lg border border-subtle p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted uppercase tracking-wide">{label}</span>
                  <button
                    onClick={() => {
                      setEditKey(key);
                      setDraft(novel.dnaCard?.[key] || '');
                    }}
                    className="rounded p-1 text-muted transition-base hover:text-primary"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
                {editKey === key ? (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-subtle bg-card p-3 text-sm focus:outline-none focus:border-visible resize-none"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditKey(null)}
                        className="rounded-md px-3 py-1.5 text-xs text-muted transition-base hover:text-primary"
                      >
                        取消
                      </button>
                      <button
                        onClick={() => void saveField(key)}
                        className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-base hover:bg-white/90"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-sm leading-relaxed text-secondary">
                    {novel.dnaCard?.[key] || '暂无内容'}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Chapters List */}
          {showChapters && (
            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索章节..."
                  className="w-full rounded-md border border-subtle bg-card py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-visible"
                />
              </div>
              <div className="max-h-80 overflow-y-auto rounded-lg border border-subtle divide-y divide-subtle">
                {filtered.slice(0, 50).map((chapter) => (
                  <div key={chapter.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span className="truncate">{chapter.name}</span>
                    <span className="text-xs text-muted">{chapter.wordCount.toLocaleString()}</span>
                  </div>
                ))}
                {filtered.length > 50 && (
                  <div className="px-4 py-2 text-xs text-muted text-center">
                    还有 {filtered.length - 50} 章...
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Extraction View */
        <div className="space-y-6">
          {/* LLM Status Warning */}
          {!llmReadiness.ok && (
            <div className="rounded-lg border border-amber-900/30 bg-amber-950/20 p-4">
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                <span className="text-sm">模型未配置</span>
              </div>
              <p className="mt-2 text-xs text-secondary">{llmReadiness.reason}</p>
              <button
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }))
                }
                className="mt-3 flex items-center gap-2 rounded-md border border-subtle px-3 py-1.5 text-xs transition-base hover:bg-card"
              >
                前往配置
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Progress */}
          {busy && (
            <div className="rounded-lg border border-subtle p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">
                    {status === 'reducing'
                      ? '汇总 DNA 中...'
                      : `章节分析中 (${progress.current}/${progress.total || chapters.length})`}
                  </span>
                </div>
                <button
                  onClick={pause}
                  className="flex items-center gap-1 rounded-md border border-subtle px-2 py-1 text-xs transition-base hover:bg-card"
                >
                  <Pause className="h-3 w-3" />
                  暂停
                </button>
              </div>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-card">
                <div
                  className="h-full bg-white transition-all duration-300"
                  style={{
                    width: `${progress.total ? (progress.current / progress.total) * 100 : status === 'reducing' ? 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Extraction Options */}
          {!busy && (
            <div className="grid gap-4 sm:grid-cols-2">
              <button
                onClick={() => handleExtract(100)}
                className="rounded-lg border border-subtle p-5 text-left transition-base hover:border-visible"
              >
                <div className="flex items-center gap-3">
                  <Zap className="h-5 w-5" />
                  <div>
                    <p className="text-sm font-medium">快速提取</p>
                    <p className="text-xs text-muted">分析前 100 章</p>
                  </div>
                </div>
              </button>

              <button
                onClick={() => handleExtract(undefined)}
                className="rounded-lg border border-subtle p-5 text-left transition-base hover:border-visible"
              >
                <div className="flex items-center gap-3">
                  <BookOpen className="h-5 w-5" />
                  <div>
                    <p className="text-sm font-medium">完整提取</p>
                    <p className="text-xs text-muted">分析全部章节</p>
                  </div>
                </div>
              </button>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-900/30 bg-red-950/20 p-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-lg border border-subtle p-4">
              <p className="text-2xl font-medium">{completedChapters}</p>
              <p className="text-xs text-muted">已分析</p>
            </div>
            <div className="rounded-lg border border-subtle p-4">
              <p className="text-2xl font-medium">{chapters.filter((c) => c.wordCount < 500).length}</p>
              <p className="text-xs text-muted">短章节</p>
            </div>
            <div className="rounded-lg border border-subtle p-4">
              <p className="text-2xl font-medium">{chapters.filter((c) => c.wordCount > 12000).length}</p>
              <p className="text-xs text-muted">长章节</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
