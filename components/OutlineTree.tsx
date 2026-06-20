'use client';

// 侧栏三级大纲树（卷-章-幕）。读走 useLiveQuery 直连 IndexedDB（写入后自动重绘，禁手动刷新 / 禁 Zustand 镜像实体）；
// 写走 db.*（新增 / 重命名 / 级联删除 / 拖拽重排），下标 / 集合算术下沉到无 Dexie 依赖的 app/outlineOps.ts 纯函数。
// 拖拽采用原生 HTML5 Drag and Drop（不引第三方库），仅同父级兄弟重排（跨父级移动属后续故事）。
// 范式镜像 NovelCard（group + hover/focus 露出操作图标）与 chapterOps（纯规划层 + 单 db.transaction 套用）。

import React, { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, GripVertical } from 'lucide-react';
import { db } from '../app/db';
import {
  nextOrder,
  planReorder,
  reindexSiblings,
  collectCascade,
  buildOutlineTree,
  type OutlineLevel,
} from '../app/outlineOps';
import AppDialog from './AppDialog';

type Level = OutlineLevel; // 'volume' | 'chapter' | 'scene'

interface DragInfo { id: string; level: Level; parentKey: string; }
interface DropInfo { id: string; position: 'before' | 'after'; }
interface EditInfo { level: Level; id: string; value: string; original: string; }
interface DeleteInfo { level: Level; id: string; title: string; chapterCount: number; sceneCount: number; }

// 默认标题（新增缺省，亦作空标题兜底显示）。
const DEFAULT_TITLE: Record<Level, string> = { volume: '新卷', chapter: '新章', scene: '新幕' };

// 写操作按层级分派到对应表——避免 Table 联合类型在 .update 上的方法签名告警。
// changes 仅含三表共有字段（title / order / updatedAt），对各表均合法。
function updateNode(level: Level, id: string, changes: { title?: string; order?: number; updatedAt: number }) {
  if (level === 'volume') return db.volumes.update(id, changes);
  if (level === 'chapter') return db.outlineChapters.update(id, changes);
  return db.scenes.update(id, changes);
}

export default function OutlineTree({ novelId }: { novelId: string }) {
  // —— 读（AC1）：三表按 novelId 过滤、按 order 升序；依赖数组带 [novelId] 使切换作品时重查 ——
  const volumes = useLiveQuery(() => db.volumes.where('novelId').equals(novelId).sortBy('order'), [novelId]);
  const chapters = useLiveQuery(() => db.outlineChapters.where('novelId').equals(novelId).sortBy('order'), [novelId]);
  const scenes = useLiveQuery(() => db.scenes.where('novelId').equals(novelId).sortBy('order'), [novelId]);

  const loading = volumes === undefined || chapters === undefined || scenes === undefined;
  const volumesAll = useMemo(() => volumes ?? [], [volumes]);
  const chaptersAll = useMemo(() => chapters ?? [], [chapters]);
  const scenesAll = useMemo(() => scenes ?? [], [scenes]);
  const tree = useMemo(() => buildOutlineTree(volumesAll, chaptersAll, scenesAll), [volumesAll, chaptersAll, scenesAll]);

  // —— 临时 UI 态（Zustand 不镜像实体；折叠 / 选中 / 编辑 / 拖拽均为组件本地态）——
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditInfo | null>(null);
  const [deleteInfo, setDeleteInfo] = useState<DeleteInfo | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropInfo, setDropInfo] = useState<DropInfo | null>(null);
  const dragRef = useRef<DragInfo | null>(null);     // 拖拽源（handler 读最新值，规避陈旧闭包）
  const editingRef = useRef<EditInfo | null>(null);  // 编辑态镜像（finishEdit 不在 setState updater 内做副作用，规避 StrictMode 双调）
  const committedRef = useRef(true);                 // Enter / blur 去重：true = 无待提交

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function expand(id: string) {
    setCollapsed((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
  }

  // —— 新增（AC2）：crypto.randomUUID + nextOrder(末位 +1) + 缺省字段；新增后展开父级使其可见 ——
  function addVolume() {
    const now = Date.now();
    void db.volumes.add({ id: crypto.randomUUID(), novelId, title: DEFAULT_TITLE.volume, order: nextOrder(volumesAll), createdAt: now, updatedAt: now });
  }
  function addChapter(volumeId: string) {
    const now = Date.now();
    const siblings = chaptersAll.filter((c) => c.volumeId === volumeId);
    void db.outlineChapters.add({ id: crypto.randomUUID(), novelId, volumeId, title: DEFAULT_TITLE.chapter, order: nextOrder(siblings), createdAt: now, updatedAt: now });
    expand(volumeId);
  }
  function addScene(chapterId: string) {
    const now = Date.now();
    const siblings = scenesAll.filter((s) => s.chapterId === chapterId);
    void db.scenes.add({ id: crypto.randomUUID(), novelId, chapterId, title: DEFAULT_TITLE.scene, order: nextOrder(siblings), synopsis: '', content: '', wordCount: 0, createdAt: now, updatedAt: now });
    expand(chapterId);
  }

  // —— 重命名（AC3）：行内编辑，Enter / 失焦提交、Esc 取消；空白或未变更不写库 ——
  function startEdit(level: Level, id: string, current: string) {
    committedRef.current = false;
    const info: EditInfo = { level, id, value: current, original: current };
    editingRef.current = info;
    setEditing(info);
  }
  function onEditChange(value: string) {
    const cur = editingRef.current;
    if (cur) editingRef.current = { ...cur, value };
    setEditing((c) => (c ? { ...c, value } : c));
  }
  function finishEdit(commit: boolean) {
    if (committedRef.current) return; // 去重：Enter 后的 blur 为空操作
    committedRef.current = true;
    const cur = editingRef.current;
    editingRef.current = null;
    setEditing(null);
    if (commit && cur) {
      const t = cur.value.trim();
      if (t && t !== cur.original) void updateNode(cur.level, cur.id, { title: t, updatedAt: Date.now() });
    }
  }

  // —— 删除（AC3）：collectCascade 收集 id，单事务级联删 + 清 draftHistory + 同父级 reindex ——
  function requestDelete(level: Level, id: string, title: string) {
    const c = collectCascade({ level, id }, { chapters: chaptersAll, scenes: scenesAll });
    setDeleteInfo({ level, id, title, chapterCount: c.chapterIds.length, sceneCount: c.sceneIds.length });
  }
  async function performDelete(info: DeleteInfo) {
    const now = Date.now();
    const cascade = collectCascade({ level: info.level, id: info.id }, { chapters: chaptersAll, scenes: scenesAll });

    // 删除后同父级剩余兄弟压缩为连续 order（消除空洞）
    let siblings: { id: string; order: number }[] = [];
    if (info.level === 'volume') {
      siblings = volumesAll.filter((v) => v.id !== info.id);
    } else if (info.level === 'chapter') {
      const me = chaptersAll.find((c) => c.id === info.id);
      siblings = me ? chaptersAll.filter((c) => c.volumeId === me.volumeId && c.id !== info.id) : [];
    } else {
      const me = scenesAll.find((s) => s.id === info.id);
      siblings = me ? scenesAll.filter((s) => s.chapterId === me.chapterId && s.id !== info.id) : [];
    }
    const reindexPlan = reindexSiblings(siblings);
    const curOrder = new Map(siblings.map((s) => [s.id, s.order]));
    const reindexChanged = reindexPlan.filter((e) => curOrder.get(e.id) !== e.order);

    await db.transaction('rw', [db.volumes, db.outlineChapters, db.scenes, db.draftHistory], async () => {
      if (cascade.sceneIds.length) {
        await db.draftHistory.where('sceneId').anyOf(cascade.sceneIds).delete();
        await db.scenes.bulkDelete(cascade.sceneIds);
      }
      if (cascade.chapterIds.length) await db.outlineChapters.bulkDelete(cascade.chapterIds);
      if (cascade.volumeIds.length) await db.volumes.bulkDelete(cascade.volumeIds);
      for (const e of reindexChanged) await updateNode(info.level, e.id, { order: e.order, updatedAt: now });
    });

    if (selectedSceneId && cascade.sceneIds.includes(selectedSceneId)) setSelectedSceneId(null);
  }

  // —— 拖拽重排（AC4）：原生 HTML5 DnD，仅同父级；planReorder 算新序，单事务批量 update ——
  function onDragStart(e: React.DragEvent, info: DragInfo) {
    dragRef.current = info;
    setDragId(info.id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', info.id); } catch { /* 某些环境禁止读写 dataTransfer，忽略 */ }
  }
  function clearDrag() { dragRef.current = null; setDragId(null); setDropInfo(null); }
  function onRowDragOver(e: React.DragEvent, level: Level, id: string, parentKey: string) {
    const d = dragRef.current;
    if (!d || d.level !== level || d.parentKey !== parentKey) return; // 跨父级 / 跨层级：不 preventDefault → 不允许 drop
    e.preventDefault();
    if (d.id === id) { setDropInfo(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    setDropInfo({ id, position: after ? 'after' : 'before' });
  }
  function onRowDrop(e: React.DragEvent, level: Level, id: string, parentKey: string, siblings: ReadonlyArray<{ id: string; order: number }>) {
    const d = dragRef.current;
    if (!d || d.level !== level || d.parentKey !== parentKey || d.id === id) { clearDrag(); return; }
    e.preventDefault();
    const ordered = [...siblings].sort((a, b) => a.order - b.order);
    const fromIdx = ordered.findIndex((s) => s.id === d.id);
    const overIdx = ordered.findIndex((s) => s.id === id);
    if (fromIdx === -1 || overIdx === -1) { clearDrag(); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const insertAt = overIdx + (after ? 1 : 0);                       // 移除前的插入位
    const targetIndex = insertAt > fromIdx ? insertAt - 1 : insertAt; // 移除后供 planReorder 的下标
    void applyReorder(level, ordered, d.id, targetIndex);
    clearDrag();
  }
  async function applyReorder(level: Level, siblings: ReadonlyArray<{ id: string; order: number }>, movedId: string, targetIndex: number) {
    const now = Date.now();
    const plan = planReorder(siblings, movedId, targetIndex);
    const curOrder = new Map(siblings.map((s) => [s.id, s.order]));
    const changed = plan.filter((e) => curOrder.get(e.id) !== e.order);
    if (!changed.length) return;
    await db.transaction('rw', [db.volumes, db.outlineChapters, db.scenes], async () => {
      for (const e of changed) await updateNode(level, e.id, { order: e.order, updatedAt: now });
    });
  }

  function renderRow(opts: {
    level: Level;
    node: { id: string; title: string; order: number };
    depth: number;
    parentKey: string;
    siblings: ReadonlyArray<{ id: string; order: number }>;
    collapsible: boolean;
    isCollapsed: boolean;
    onAddChild?: () => void;
    addChildLabel?: string;
  }) {
    const { level, node, depth, parentKey, siblings, collapsible, isCollapsed, onAddChild, addChildLabel } = opts;
    const id = node.id;
    const isEditing = editing !== null && editing.level === level && editing.id === id;
    const isSelected = level === 'scene' && selectedSceneId === id;
    const isDragging = dragId === id;
    const showBefore = dropInfo?.id === id && dropInfo.position === 'before';
    const showAfter = dropInfo?.id === id && dropInfo.position === 'after';
    const padLeft = 6 + depth * 14;
    const indicatorMargin = padLeft + 12;

    return (
      <div key={id}>
        {showBefore && <div className="h-0.5 -my-px rounded-full bg-accent" style={{ marginLeft: indicatorMargin }} aria-hidden />}
        <div
          className={`group flex h-7 items-center gap-1 rounded-sm border-l-2 pr-1 transition-colors motion-reduce:transition-none ${
            isSelected ? 'border-accent bg-accent-subtle' : 'border-transparent hover:bg-raised'
          } ${isDragging ? 'opacity-40' : ''}`}
          style={{ paddingLeft: padLeft }}
          onDragOver={(e) => onRowDragOver(e, level, id, parentKey)}
          onDrop={(e) => onRowDrop(e, level, id, parentKey, siblings)}
        >
          {/* 折叠箭头（卷 / 章）或叶子标记（幕） */}
          {collapsible ? (
            <button
              type="button"
              onClick={() => toggleCollapse(id)}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:text-fg motion-reduce:transition-none"
              aria-label={isCollapsed ? '展开' : '折叠'}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          ) : (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
              <span className="h-1 w-1 rounded-full bg-fg-subtle" />
            </span>
          )}

          {/* 标题：编辑态为行内输入；否则卷 / 章点击折叠、幕点击选中高亮 */}
          {isEditing ? (
            <input
              autoFocus
              value={editing ? editing.value : ''}
              onChange={(e) => onEditChange(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => finishEdit(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
                else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
              }}
              className="h-5 min-w-0 flex-1 rounded-sm border border-accent bg-surface px-1.5 text-[13px] text-fg outline-none"
              aria-label="重命名"
            />
          ) : (
            <button
              type="button"
              onClick={() => (level === 'scene' ? setSelectedSceneId(id) : toggleCollapse(id))}
              className={`min-w-0 flex-1 truncate text-left text-[13px] ${
                level === 'volume' ? 'font-medium text-fg' : level === 'chapter' ? 'text-fg' : 'text-fg-muted'
              }`}
              title={node.title}
            >
              {node.title || DEFAULT_TITLE[level]}
            </button>
          )}

          {/* 行内操作（hover / 聚焦露出）：拖拽柄 + 新增子级 + 重命名 + 删除 */}
          {!isEditing && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
              <span
                draggable
                onDragStart={(e) => onDragStart(e, { id, level, parentKey })}
                onDragEnd={clearDrag}
                role="button"
                aria-label="拖拽重排"
                title="拖拽重排"
                className="flex h-5 w-5 cursor-grab items-center justify-center rounded-sm text-fg-subtle hover:text-fg active:cursor-grabbing"
              >
                <GripVertical size={13} />
              </span>
              {onAddChild && (
                <button type="button" onClick={onAddChild} aria-label={addChildLabel} title={addChildLabel} className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface hover:text-fg">
                  <Plus size={13} />
                </button>
              )}
              <button type="button" onClick={() => startEdit(level, id, node.title)} aria-label="重命名" title="重命名" className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface hover:text-fg">
                <Pencil size={12} />
              </button>
              <button type="button" onClick={() => requestDelete(level, id, node.title)} aria-label="删除" title="删除" className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface hover:text-danger">
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
        {showAfter && <div className="h-0.5 -my-px rounded-full bg-accent" style={{ marginLeft: indicatorMargin }} aria-hidden />}
      </div>
    );
  }

  const deleteName = deleteInfo ? (deleteInfo.title || DEFAULT_TITLE[deleteInfo.level]) : '';
  const deleteDescription = !deleteInfo
    ? ''
    : deleteInfo.level === 'volume'
    ? `《${deleteName}》及其 ${deleteInfo.chapterCount} 个章、${deleteInfo.sceneCount} 个幕将被永久删除，且无法恢复。`
    : deleteInfo.level === 'chapter'
    ? `《${deleteName}》及其 ${deleteInfo.sceneCount} 个幕将被永久删除，且无法恢复。`
    : `《${deleteName}》将被永久删除，且无法恢复。`;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={addVolume}
        disabled={loading}
        className="mb-1 flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50 motion-reduce:transition-none"
      >
        <Plus size={13} /> 新增卷
      </button>

      {loading ? null : volumesAll.length === 0 ? (
        <p className="px-2 py-2 text-[12.5px] leading-relaxed text-fg-subtle">还没有大纲，点击上方「新增卷」创建第一卷。</p>
      ) : (
        <div className="space-y-0.5">
          {tree.map((vNode) => {
            const volume = vNode.volume;
            const vCollapsed = collapsed.has(volume.id);
            const chapterSiblings = vNode.chapters.map((c) => c.chapter);
            return (
              <React.Fragment key={volume.id}>
                {renderRow({ level: 'volume', node: volume, depth: 0, parentKey: novelId, siblings: volumesAll, collapsible: true, isCollapsed: vCollapsed, onAddChild: () => addChapter(volume.id), addChildLabel: '新增章' })}
                {!vCollapsed && vNode.chapters.map((cNode) => {
                  const chapter = cNode.chapter;
                  const cCollapsed = collapsed.has(chapter.id);
                  const sceneSiblings = cNode.scenes.map((s) => s.scene);
                  return (
                    <React.Fragment key={chapter.id}>
                      {renderRow({ level: 'chapter', node: chapter, depth: 1, parentKey: volume.id, siblings: chapterSiblings, collapsible: true, isCollapsed: cCollapsed, onAddChild: () => addScene(chapter.id), addChildLabel: '新增幕' })}
                      {!cCollapsed && cNode.scenes.map((sNode) =>
                        renderRow({ level: 'scene', node: sNode.scene, depth: 2, parentKey: chapter.id, siblings: sceneSiblings, collapsible: false, isCollapsed: false }),
                      )}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      )}

      <AppDialog
        open={deleteInfo !== null}
        title="确认删除？"
        description={deleteDescription}
        confirmLabel="确认删除"
        confirmTone="danger"
        onClose={() => setDeleteInfo(null)}
        onConfirm={() => { if (deleteInfo) void performDelete(deleteInfo); setDeleteInfo(null); }}
      />
    </div>
  );
}
