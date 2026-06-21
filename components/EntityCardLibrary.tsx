'use client';

// 侧栏「设定卡库」面板（与三级大纲树同侧栏的兄弟组件，范式镜像 OutlineTree）。
// 读：useLiveQuery 直连 IndexedDB 按 novelId 取本书全部设定卡（写入后自动重绘，禁手动刷新 / 禁 Zustand 镜像实体）；
//     再用 entityCardOps.groupCardsByType 按 type 固定顺序（世界规章/人物/道具/地理）装配分组。
// 写：db.entityCards.add/update + 删除走单个 db.transaction（delete + 同 (novelId,type) 组 reindexCards 压缩 order）。
// 下标 / 集合算术全部下沉到无 Dexie 依赖的 app/entityCardOps.ts 纯函数（可单测）。
// 活跃态（activeState 三态 / Badge / 上下文路由）属 Story 2.3——本故事新卡一律落 'idle'、不展示 / 不切换。

import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Pencil, Trash2, Globe, User, Package, MapPin, type LucideIcon } from 'lucide-react';
import { db } from '../app/db';
import { nextOrder, reindexCards, groupCardsByType, ENTITY_CARD_TYPE_LABELS } from '../app/entityCardOps';
import { isEntityActiveState } from '../app/memorySchema';
import type { EntityCard, EntityCardType, EntityActiveState } from '../app/memorySchema';
import AppDialog from './AppDialog';
import EntityCardEditor, { type EntityCardFormData } from './EntityCardEditor';

// 四类设定卡的行首图标（仅 lucide-react，禁 Emoji）。
const TYPE_ICON: Record<EntityCardType, LucideIcon> = {
  worldview: Globe,
  character: User,
  prop: Package,
  geography: MapPin,
};

// 新建弹窗的默认入口类型（人物最常用）；亦作弹窗关闭态的稳定 initial 兜底。
const CREATE_DEFAULT: EntityCardFormData = { type: 'character', name: '', summary: '', details: '' };

type EditorState =
  | { mode: 'create'; initial: EntityCardFormData }
  | { mode: 'edit'; id: string; initial: EntityCardFormData }
  | null;

export default function EntityCardLibrary({ novelId }: { novelId: string }) {
  // —— 读（AC1）：按 novelId 过滤、按 order 升序；依赖数组带 [novelId] 使切换作品时重查 ——
  const cards = useLiveQuery(
    () => db.entityCards.where('novelId').equals(novelId).sortBy('order'),
    [novelId],
  );
  const loading = cards === undefined;
  const cardsAll = useMemo(() => cards ?? [], [cards]);
  const groups = useMemo(() => groupCardsByType(cardsAll), [cardsAll]);
  const nonEmptyGroups = groups.filter((g) => g.cards.length > 0);

  // —— 临时 UI 态（组件本地，Zustand 不镜像实体）：编辑器开关 / 当前编辑卡 / 删除确认目标 ——
  const [editorState, setEditorState] = useState<EditorState>(null);
  const [deleteTarget, setDeleteTarget] = useState<EntityCard | null>(null);

  async function toggleActiveState(card: EntityCard, e: React.MouseEvent) {
    e.stopPropagation();
    const nextStateMap: Record<EntityActiveState, EntityActiveState> = {
      idle: 'sceneActive',
      sceneActive: 'globalActive',
      globalActive: 'idle',
    };
    const currentState = isEntityActiveState(card.activeState) ? card.activeState : 'idle';
    const nextState = nextStateMap[currentState];
    await db.entityCards.update(card.id, {
      activeState: nextState,
      updatedAt: Date.now(),
    });
  }

  function renderActiveBadge(card: EntityCard) {
    const state = card.activeState || 'idle';
    if (state === 'idle') {
      return (
        <button
          type="button"
          onClick={(e) => void toggleActiveState(card, e)}
          className="hidden group-hover:inline-flex group-focus-within:inline-flex items-center justify-center shrink-0 border border-dashed border-line text-fg-subtle rounded-full px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap cursor-pointer hover:bg-raised hover:text-fg select-none outline-none transition-colors"
        >
          闲置
        </button>
      );
    }

    const label = state === 'sceneActive' ? '场景活跃' : '全局活跃';
    return (
      <button
        type="button"
        onClick={(e) => void toggleActiveState(card, e)}
        className="inline-flex items-center justify-center shrink-0 bg-success/10 text-success border border-success/30 rounded-full px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap cursor-pointer hover:bg-success/20 select-none outline-none transition-colors"
      >
        {label}
      </button>
    );
  }

  function openCreate() {
    setEditorState({ mode: 'create', initial: { ...CREATE_DEFAULT } });
  }
  function openEdit(card: EntityCard) {
    setEditorState({
      mode: 'edit',
      id: card.id,
      initial: { type: card.type, name: card.name, summary: card.summary, details: card.details },
    });
  }

  // —— 新增（AC2）：crypto.randomUUID + 同 type 组末位 order + activeState:'idle' + 冗余 novelId + 时间戳 ——
  async function addCard(data: EntityCardFormData) {
    const now = Date.now();
    const siblings = cardsAll.filter((c) => c.type === data.type); // 同一 (novelId, type) 组
    await db.entityCards.add({
      id: crypto.randomUUID(),
      novelId,
      type: data.type,
      name: data.name, // 编辑器已 trim 且保证非空
      summary: data.summary,
      details: data.details,
      activeState: 'idle', // 本故事不暴露切换（活跃态归 Story 2.3）
      order: nextOrder(siblings),
      createdAt: now,
      updatedAt: now,
    });
  }

  // —— 编辑（AC3）：仅更新可编辑字段 + updatedAt；改 type 后由 groupCardsByType 重绘自动归入新组（不动 order）——
  async function updateCard(id: string, data: EntityCardFormData) {
    await db.entityCards.update(id, {
      name: data.name,
      type: data.type,
      summary: data.summary,
      details: data.details,
      updatedAt: Date.now(),
    });
  }

  function handleSubmit(data: EntityCardFormData) {
    if (!editorState) return;
    if (editorState.mode === 'create') void addCard(data);
    else void updateCard(editorState.id, data);
    setEditorState(null);
  }

  // —— 删除（AC4）：单事务内 delete + 对同 (novelId, type) 组剩余卡 reindexCards 压缩 order（仅写变化项）——
  async function performDelete(card: EntityCard) {
    const now = Date.now();
    const siblings = cardsAll.filter((c) => c.type === card.type && c.id !== card.id);
    const plan = reindexCards(siblings);
    const curOrder = new Map(siblings.map((s) => [s.id, s.order]));
    const changed = plan.filter((e) => curOrder.get(e.id) !== e.order);
    await db.transaction('rw', db.entityCards, async () => {
      await db.entityCards.delete(card.id);
      for (const e of changed) await db.entityCards.update(e.id, { order: e.order, updatedAt: now });
    });
  }

  function renderCardRow(card: EntityCard) {
    const Icon = TYPE_ICON[card.type];
    return (
      <div
        key={card.id}
        className="group flex items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-1.5 transition-colors hover:bg-raised motion-reduce:transition-none"
      >
        <Icon size={14} className="shrink-0 text-fg-subtle" aria-hidden />
        {/* 点击卡片行即编辑（AC3：hover ✎ 或点击卡片行皆可编辑） */}
        <button type="button" onClick={() => openEdit(card)} className="min-w-0 flex-1 text-left" title={card.name}>
          <span className="block truncate text-[13px] text-fg">{card.name}</span>
          {card.summary && (
            <span className="block truncate text-[11.5px] leading-snug text-fg-subtle">{card.summary}</span>
          )}
        </button>

        {renderActiveBadge(card)}

        {/* 行内操作（hover / 聚焦露出）：编辑 + 删除 */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
          <button
            type="button"
            onClick={() => openEdit(card)}
            aria-label={`编辑《${card.name}》`}
            title="编辑"
            className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface hover:text-fg"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={() => setDeleteTarget(card)}
            aria-label={`删除《${card.name}》`}
            title="删除"
            className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface hover:text-danger"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={openCreate}
        disabled={loading}
        className="mb-2 flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50 motion-reduce:transition-none"
      >
        <Plus size={13} /> 新增设定卡
      </button>

      {loading ? null : cardsAll.length === 0 ? (
        <p className="px-2 py-2 text-[12.5px] leading-relaxed text-fg-subtle">
          还没有设定卡，点击上方「新增设定卡」创建第一张。
        </p>
      ) : (
        <div className="space-y-3">
          {nonEmptyGroups.map((group) => (
            <div key={group.type} className="space-y-1">
              <div className="px-1">
                <span className="eyebrow">{ENTITY_CARD_TYPE_LABELS[group.type]}</span>
              </div>
              <div className="space-y-1">{group.cards.map(renderCardRow)}</div>
            </div>
          ))}
        </div>
      )}

      <EntityCardEditor
        open={editorState !== null}
        mode={editorState?.mode ?? 'create'}
        initial={editorState?.initial ?? CREATE_DEFAULT}
        onClose={() => setEditorState(null)}
        onSubmit={handleSubmit}
      />

      <AppDialog
        open={deleteTarget !== null}
        title="确认删除？"
        description={deleteTarget ? `该设定卡《${deleteTarget.name}》将被永久删除，且无法恢复。` : ''}
        confirmLabel="确认删除"
        confirmTone="danger"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void performDelete(deleteTarget);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
