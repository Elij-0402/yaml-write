'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Upload, Loader2, FileText, Plus } from 'lucide-react';
import { db, type Novel, type SplitStatus } from '../app/db';
import { useAppStore } from '../app/store';
import { parseNovelFile } from '../app/novelParser';
import { planBlobPresplit } from '../app/blobPresplit';
import { rescoreSplit } from '../app/splitQuality';
import { OVERSIZED_CHAPTER_CHARS } from '../app/dnaRouting';
import NovelCard from './NovelCard';
import AppNotice from './AppNotice';

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

type UploadStage = 'idle' | 'detecting' | 'reading' | 'splitting' | 'hashing' | 'saving';
const STAGE_LABEL: Record<UploadStage, string> = {
  idle: '',
  detecting: '识别文本编码与文件结构…',
  reading: '清洗文本并提取正文…',
  splitting: '按章节规则切分内容…',
  hashing: '计算内容指纹与一致性校验…',
  saving: '写入本地项目与章节索引…',
};

export default function LibraryView({ onRequestDelete }: { onRequestDelete: (novel: Novel) => void }) {
  const { selectedNovelId, setSelectedNovelId, setManageMode } = useAppStore();
  const novelsRaw = useLiveQuery<Novel[]>(() => db.novels.orderBy('createdAt').reverse().toArray(), []);
  const novels = useMemo(() => novelsRaw || [], [novelsRaw]);

  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadStageText, setUploadStageText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parserAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => parserAbortRef.current?.abort(), []);

  const ensureStorageCapacity = async (file: File): Promise<void> => {
    const storageManager = (navigator as Navigator & { storage?: StorageManager }).storage;
    if (!storageManager || typeof storageManager.estimate !== 'function') return;
    try {
      const estimate = await storageManager.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      if (!quota) return;
      const freeBytes = quota - usage;
      const requiredBytes = Math.max(file.size * 2.2, 8 * 1024 * 1024);
      if (freeBytes < requiredBytes) throw new Error('存储空间不足');
    } catch (err) {
      if (err instanceof Error && err.message.includes('存储空间')) throw err;
    }
  };

  const processFile = async (file: File) => {
    if (uploading) return;
    if (!file.name.toLowerCase().endsWith('.txt')) { setErrorMsg('仅支持 .txt'); return; }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) { setErrorMsg(`文件过大 (>${MAX_UPLOAD_SIZE_MB}MB)`); return; }

    setUploading(true);
    setUploadStage('detecting');
    setUploadStageText('');
    setErrorMsg(null);

    const novelId = crypto.randomUUID();
    const novelName = file.name.replace(/\.[^/.]+$/, '');
    const ac = new AbortController();
    parserAbortRef.current = ac;

    try {
      await ensureStorageCapacity(file);
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();

      const { chapters: parsedChapters, splitMeta: computedSplitMeta, cleanedText, purifiedCount } =
        await parseNovelFile(file, {
          signal: ac.signal,
          onProgress: ({ stage, percent }) => {
            setUploadStage(stage as UploadStage);
            setUploadStageText(percent !== undefined ? `${percent}%` : '');
          },
        });

      setUploadStage('saving');
      setUploadStageText('');

      // 超长 blob 自动预切（盗版 txt 把整本塞进单章）：切成 ≤12k 片，杜绝砍尾 + 清掉超大章误锁；预切后就地 rescore。
      const presplit = planBlobPresplit(parsedChapters);
      const effectiveChapters = presplit.chapters;
      const { splitStatus: effSplitStatus, splitMeta: effSplitMeta } = presplit.didSplit
        ? rescoreSplit(
            effectiveChapters.map((c) => ({ name: c.title, wordCount: c.wordCount, chapterIndex: c.chapterIndex })),
            computedSplitMeta,
          )
        : { splitStatus: (computedSplitMeta.confidenceLevel === 'low' ? 'needs_review' : 'ok') as SplitStatus, splitMeta: computedSplitMeta };

      await db.transaction('rw', [db.novels, db.chapters], async () => {
        await db.novels.add({
          id: novelId,
          name: novelName,
          wordCount: effectiveChapters.reduce((sum, c) => sum + c.wordCount, 0),
          createdAt: Date.now(),
          purifiedCount,
          sourceTextCleaned: cleanedText,
          splitStatus: effSplitStatus,
          splitMeta: effSplitMeta,
          analysisStatus: 'idle',
          mapProgress: { total: 0, current: 0 },
          dnaCard: null,
        });
        const chaptersToSave = effectiveChapters.map((chapter) => ({
          id: crypto.randomUUID(),
          novelId,
          chapterIndex: chapter.chapterIndex,
          name: chapter.title,
          content: chapter.content,
          wordCount: chapter.wordCount,
          contentSha256: chapter.contentSha256,
          status: 'unparsed' as const,
          mapStatus: 'pending' as const,
        }));
        await db.chapters.bulkAdd(chaptersToSave);
      });

      // 导入后自动分流（goal·流程自动化）：
      // · 高置信切分 → 落 DNA 板（manageMode=false），后台自动起提取（见 page.tsx 置信度闸）。
      // · 中置信切分 → 落 DNA 板，但不自动跑；DNA 板给非阻塞提示 + 「直接开始提取」一键继续。
      // · 低置信 / 超长章节 → 落「章节校验」台（manageMode=true），先人工修复再继续。
      const hasOversized = effectiveChapters.some((c) => c.wordCount > OVERSIZED_CHAPTER_CHARS);
      const needsReview = effSplitMeta.confidenceLevel === 'low' || hasOversized;
      setSelectedNovelId(novelId);
      setManageMode(needsReview);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setErrorMsg(err instanceof Error ? err.message : '解析或保存小说失败');
    } finally {
      setUploading(false);
      setUploadStage('idle');
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) await processFile(e.dataTransfer.files[0]);
  };
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) await processFile(e.target.files[0]);
    e.target.value = '';
  };

  const empty = novels.length === 0;

  const dropZone = (
    <div
      onClick={() => fileInputRef.current?.click()}
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed text-center transition-colors ${
        empty ? 'gap-4 px-8 py-14' : 'gap-1.5 px-6 py-5'
      } ${dragActive ? 'border-accent bg-accent-subtle' : 'border-line bg-panel hover:border-fg-subtle'}`}
    >
      <div className={`flex items-center justify-center rounded-full border border-line bg-surface text-fg-muted ${empty ? 'h-12 w-12' : 'h-8 w-8'}`}>
        <Upload size={empty ? 19 : 14} />
      </div>
      <div>
        <p className={`font-medium ${empty ? 'text-sm' : 'text-[13px]'} ${dragActive ? 'text-accent-ink' : 'text-fg'}`}>
          {dragActive ? '松开鼠标，开始导入' : '点击选择或拖拽 TXT 到这里'}
        </p>
        <p className="mt-1 text-xs leading-5 text-fg-subtle">UTF-8 / GB18030 / BIG5 自适应识别 · 单文件 ≤ {MAX_UPLOAD_SIZE_MB}MB</p>
      </div>
    </div>
  );

  return (
    <div className="view-enter mx-auto w-full max-w-[880px]">
      <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".txt" className="hidden" />

      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-fg">作品库</h1>
          <p className="mt-1 text-[13px] text-fg-muted">导入读过的书，提炼成可换皮的 4 层 DNA。</p>
        </div>
        {!empty && (
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="font-mono text-xs tabular-nums text-fg-subtle">{novels.length} 部</span>
            <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              <Plus size={14} /> 导入作品
            </button>
          </div>
        )}
      </div>

      {empty ? (
        <div className="space-y-5">
          {dropZone}
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['01', '导入文本', '识别编码、净化噪音，把原稿变成可处理的项目。'],
              ['02', '校验切分', '把异常章节与风险位置提前暴露，避免错误带到后面。'],
              ['03', '生成 DNA', '结构可靠后，交给模型提取骨架、题材与文笔。'],
            ].map(([idx, title, desc]) => (
              <div key={idx} className="card p-4">
                <div className="eyebrow">{idx}</div>
                <div className="mt-2 flex items-center gap-1.5 text-[13px] font-medium text-fg">
                  <FileText size={13} className="text-fg-subtle" />{title}
                </div>
                <p className="mt-1 text-xs leading-6 text-fg-muted">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {dropZone}
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="divide-y divide-line-2">
              {novels.map((novel) => (
                <NovelCard
                  key={novel.id}
                  novel={novel}
                  active={selectedNovelId === novel.id}
                  onOpen={() => setSelectedNovelId(novel.id)}
                  onDelete={() => onRequestDelete(novel)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {uploading && (
        <div className="card mt-5 flex items-center gap-3.5 p-4">
          <Loader2 size={18} className="shrink-0 animate-spin text-accent-ink motion-reduce:animate-none" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-fg">{STAGE_LABEL[uploadStage]}</p>
            <p className="mt-0.5 text-xs leading-5 text-fg-muted">
              切分质量达标会直接进入 DNA，存疑才转人工校验。
              {uploadStageText && <span className="ml-1 font-mono text-accent-ink">{uploadStageText}</span>}
            </p>
          </div>
        </div>
      )}

      {errorMsg && (
        <AppNotice tone="error" title="导入失败" className="mt-5">{errorMsg}</AppNotice>
      )}
    </div>
  );
}
