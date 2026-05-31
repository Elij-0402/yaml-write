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
  const { llmConfig, setManageMode, setWorkshopOpen } = useAppStore((state) => ({
    llmConfig: state.llmConfig,
    setManageMode: state.setManageMode,
    setWorkshopOpen: state.setWorkshopOpen,
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

  const saveField = async (key: keyof NovelDNACard) => {
    if (!novel.dnaCard) return;
    await db.novels.update(novelId, { dnaCard: { ...novel.dnaCard, [key]: draft } });
    setEditKey(null);
  };

  return (
    <div className="max-w-3xl space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg">{novel.name}</h1>
          <p className="mt-1 text-sm text-secondary">
            {formatWordCount(novel.wordCount)} · {chapters.length}章
          </p>
        </div>
        <button onClick={() => setManageMode(true)} className="text-sm text-secondary hover:text-primary">
          校验章节
        </button>
      </div>

      {/* DNA Ready */}
      {dnaReady ? (
        <div className="space-y-6">
          <div className="flex items-center justify-between border-b pb-4">
            <span className="text-sm text-emerald-500">DNA 就绪</span>
            {readyNovelCount >= 2 && (
              <button onClick={() => setWorkshopOpen(true)} className="text-sm text-secondary hover:text-primary">
                进入融合工坊 →
              </button>
            )}
          </div>

          {DNA_FIELDS.map(({ key, label }) => (
            <div key={key} className="border-b pb-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">{label}</span>
                {editKey !== key && (
                  <button
                    onClick={() => { setEditKey(key); setDraft(novel.dnaCard?.[key] || ''); }}
                    className="text-xs text-muted hover:text-secondary"
                  >
                    编辑
                  </button>
                )}
              </div>
              {editKey === key ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={4}
                    className="w-full border bg-transparent p-2 text-sm focus:outline-none"
                  />
                  <div className="flex gap-3 text-sm">
                    <button onClick={() => setEditKey(null)} className="text-secondary hover:text-primary">取消</button>
                    <button onClick={() => void saveField(key)} className="text-primary">保存</button>
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
        <div className="space-y-6">
          {!llmReadiness.ok && (
            <div className="border-l-2 border-amber-500 pl-4 text-sm">
              <p className="text-amber-500">模型未配置</p>
              <p className="mt-1 text-secondary">{llmReadiness.reason}</p>
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('open-settings-panel', { detail: { intent: 'DNA 提取' } }))}
                className="mt-2 text-secondary hover:text-primary"
              >
                前往配置 →
              </button>
            </div>
          )}

          {busy && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>
                  {status === 'reducing' ? '汇总 DNA...' : `分析中 ${progress.current}/${progress.total || chapters.length}`}
                </span>
                <button onClick={pause} className="text-secondary hover:text-primary">暂停</button>
              </div>
              <div className="h-px bg-secondary">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : status === 'reducing' ? 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {!busy && llmReadiness.ok && (
            <div className="flex gap-6 text-sm">
              <button onClick={() => handleExtract(100)} className="text-secondary hover:text-primary">
                快速提取 (100章)
              </button>
              <button onClick={() => handleExtract(undefined)} className="text-secondary hover:text-primary">
                完整提取 (全部)
              </button>
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-8 text-sm text-secondary">
            <span>已分析: {chapters.filter((c) => c.mapStatus === 'done').length}</span>
            <span>短章: {chapters.filter((c) => c.wordCount < 500).length}</span>
            <span>长章: {chapters.filter((c) => c.wordCount > 12000).length}</span>
          </div>
        </div>
      )}
    </div>
  );
}
