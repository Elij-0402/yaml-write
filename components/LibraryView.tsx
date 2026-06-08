'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Upload, Loader2, FileText } from 'lucide-react';
import { db, type Novel, type SplitStatus } from '../app/db';
import { useAppStore } from '../app/store';
import { parseNovelFile } from '../app/novelParser';
import { planBlobPresplit } from '../app/blobPresplit';
import { rescoreSplit } from '../app/splitQuality';
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

async function computeSha256(text: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

      // 导入后落到「章节校验」工作区：先看见章节+质量再显式进 DNA。
      setSelectedNovelId(novelId);
      setManageMode(true);
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
        empty ? 'gap-4 px-8 py-16' : 'gap-2 px-6 py-8'
      } ${dragActive ? 'border-accent bg-accent-subtle' : 'border-line bg-panel hover:border-fg-subtle'}`}
    >
      <div className={`flex items-center justify-center rounded-full border border-line bg-surface text-fg-muted ${empty ? 'h-14 w-14' : 'h-10 w-10'}`}>
        <Upload size={empty ? 22 : 18} />
      </div>
      <div>
        <p className="text-sm font-medium text-fg" style={{ color: dragActive ? 'var(--accent)' : undefined }}>
          {dragActive ? '松开鼠标，开始导入' : '点击选择或拖拽 TXT 到这里'}
        </p>
        <p className="mt-1.5 text-xs leading-6 text-fg-muted">支持 UTF-8 / GB18030 / BIG5 自适应识别 · 单文件 ≤ {MAX_UPLOAD_SIZE_MB}MB</p>
      </div>
    </div>
  );

  return (
    <div className="view-enter mx-auto w-full max-w-5xl">
      <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".txt" className="hidden" />

      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">作品库</h1>
          <p className="mt-1 text-sm text-fg-muted">导入读过的书，提炼成可换皮的 4 层 DNA。</p>
        </div>
        {!empty && <span className="chip">{novels.length} 部作品</span>}
      </div>

      {empty ? (
        <div className="space-y-6">
          {dropZone}
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['01', '导入文本', '识别编码、净化噪音，把原稿变成可处理的项目。'],
              ['02', '校验切分', '把异常章节与风险位置提前暴露，避免错误带到后面。'],
              ['03', '生成 DNA', '结构可靠后，交给模型提取骨架、题材与文笔。'],
            ].map(([idx, title, desc]) => (
              <div key={idx} className="card p-4">
                <div className="eyebrow">{idx}</div>
                <div className="mt-2 flex items-center gap-1.5 text-sm font-medium text-fg">
                  <FileText size={14} className="text-fg-subtle" />{title}
                </div>
                <p className="mt-1 text-xs leading-6 text-fg-muted">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {dropZone}
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
      )}

      {uploading && (
        <div className="card mt-6 flex items-center gap-4 p-5">
          <Loader2 size={22} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{STAGE_LABEL[uploadStage]}</p>
            <p className="mt-0.5 text-xs leading-6 text-fg-muted">
              导入完成后会自动进入切分校验。
              {uploadStageText && <span className="ml-1 font-mono text-accent">{uploadStageText}</span>}
            </p>
          </div>
        </div>
      )}

      {errorMsg && (
        <AppNotice tone="error" title="导入失败" className="mt-6">{errorMsg}</AppNotice>
      )}
    </div>
  );
}
