'use client';

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Pencil, X, ArrowRight, Copy } from 'lucide-react';
import { db, type FusionSession, type Novel } from '../app/db';
import { isDnaReady } from '../app/dnaState';
import { useAppStore } from '../app/store';

const STEP_LABEL: Record<FusionSession['step'], string> = {
  material: '配方',
  directions: '方向',
  creator: '设定',
  manuscript: '成稿',
};

function formatWhen(ts: number): string {
  try {
    const d = new Date(ts);
    const mm = `${d.getMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getDate()}`.padStart(2, '0');
    return `${mm}-${dd} ${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
  } catch {
    return '';
  }
}

export default function CreationsView({
  onRequestDelete,
  onRequestRename,
}: {
  onRequestDelete: (creation: FusionSession) => void;
  onRequestRename: (creation: FusionSession) => void;
}) {
  const { activeCreationId, setActiveCreationId, setSelectedNovelId } = useAppStore();
  const readyCount = useLiveQuery(() => db.novels.filter((n) => isDnaReady(n)).count(), []) || 0;
  const creationsRaw = useLiveQuery<FusionSession[]>(() => db.fusionSessions.orderBy('updatedAt').reverse().toArray(), []);
  const novelsRaw = useLiveQuery<Novel[]>(() => db.novels.toArray(), []);
  // id → 书名，用于在创作卡上回显「骨架×题材」配方溯源（书被删则标「已删除作品」）。
  const novelById = useMemo(() => new Map((novelsRaw || []).map((n) => [n.id, n.name])), [novelsRaw]);
  // 创作库：仅展示已进入创作台或已有正文的创作（过滤未成形的空白/方向期会话）。
  const creations = useMemo(
    () => (creationsRaw || []).filter(
      (c) => c.step === 'creator' || c.step === 'manuscript' || Object.keys(c.sceneTexts || {}).length > 0
    ),
    [creationsRaw]
  );

  const sourceLabel = (c: FusionSession): string => {
    const engId = c.selectedIds?.[0];
    const skinId = c.selectedIds?.[1];
    if (!engId) return '未指定骨架';
    const eng = novelById.get(engId) ?? '已删除作品';
    const skin = skinId ? (novelById.get(skinId) ?? '已删除作品') : null;
    return skin ? `骨架《${eng}》× 题材《${skin}》` : `骨架《${eng}》× 口述题材`;
  };

  const canCreate = readyCount >= 1;
  const startNew = () => { if (canCreate) setActiveCreationId(crypto.randomUUID()); };

  // 复制创作做变体：同配方/设定 fork 一条新创作，清空开篇正文与历史（重新写一版开篇），随即打开。
  const duplicateCreation = async (c: FusionSession) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.fusionSessions.put({
      ...c,
      id,
      name: `${c.name || c.directionTitle || '未命名创作'} 副本`,
      createdAt: now,
      updatedAt: now,
      sceneTexts: {},
      sceneResumeStatus: {},
      openingDrafts: [],
    });
    setActiveCreationId(id);
  };

  return (
    <div className="view-enter mx-auto w-full max-w-5xl">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">创作库</h1>
          <p className="mt-1 text-sm text-fg-muted">用一本书当骨架、一本书换题材，生成形似神不似的新书开篇。</p>
        </div>
        <button className="btn btn-primary" onClick={startNew} disabled={!canCreate}>
          <Plus size={15} /> 新建创作
        </button>
      </div>

      {!canCreate ? (
        <div className="card flex flex-col items-center gap-3 px-8 py-16 text-center">
          <p className="text-sm font-medium text-fg">还没有 DNA 就绪的作品</p>
          <p className="max-w-sm text-xs leading-6 text-fg-muted">创作工坊吃的是已提炼完成的 4 层 DNA。先去作品库导入并提取一本书的 DNA，这里就会点亮。</p>
          <button className="btn btn-secondary mt-1" onClick={() => setSelectedNovelId(null)}>前往作品库</button>
        </div>
      ) : creations.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-8 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-panel text-fg-muted">
            <Plus size={20} />
          </div>
          <p className="text-sm font-medium text-fg">开始第一条创作</p>
          <p className="max-w-sm text-xs leading-6 text-fg-muted">已有 {readyCount} 本 DNA 就绪。新建一条创作，挑骨架与题材，工坊会生成 3 个方向供你往下走。</p>
          <button className="btn btn-primary mt-1" onClick={startNew}><Plus size={15} /> 新建创作</button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {creations.map((c) => {
            const active = activeCreationId === c.id;
            const name = c.name || c.directionTitle || '未命名创作';
            return (
              <div
                key={c.id}
                className={`card group relative cursor-pointer p-4 transition-colors hover:border-fg-subtle ${active ? 'border-accent' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setActiveCreationId(c.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveCreationId(c.id); } }}
              >
                <div className="truncate pr-16 text-sm font-medium text-fg" title={name}>{name}</div>
                <div className="mt-1.5 truncate text-xs text-fg-subtle" title={sourceLabel(c)}>{sourceLabel(c)}</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="chip">{STEP_LABEL[c.step]}</span>
                  <span className="font-mono text-xs tabular-nums text-fg-subtle">{formatWhen(c.updatedAt)}</span>
                </div>
                <span className="mt-3 flex items-center gap-1 text-xs text-fg-subtle opacity-0 transition group-hover:opacity-100">
                  继续创作 <ArrowRight size={12} />
                </span>
                <div className="absolute right-2 top-2 flex gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    onClick={(e) => { e.stopPropagation(); void duplicateCreation(c); }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-raised hover:text-fg"
                    aria-label="复制为新创作"
                    title="复制为新创作（同配方换条路线）"
                  ><Copy size={13} /></button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRequestRename(c); }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-raised hover:text-fg"
                    aria-label="重命名创作"
                  ><Pencil size={13} /></button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRequestDelete(c); }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-raised hover:text-danger"
                    aria-label="删除创作"
                  ><X size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
