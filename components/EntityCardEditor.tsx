'use client';

// 设定卡「新增 / 编辑」弹窗（多字段表单）。AppDialog 只支持单 inputLabel 输入、且被 5 处复用——故不扩它，
// 这里新建独立模态：镜像 AppDialog 的 scrim 遮罩 + glass/pop-enter/shadow-pop 容器 + role=dialog + aria-modal + Esc 关闭 + useFocusTrap。
// 纯受控表单（name/type/summary/details）；open 切换时 effect 回填（编辑）/ 重置（新建），仿 AppDialog:36-38。
// 提交后由 EntityCardLibrary 写库，读走 useLiveQuery 自动重绘，本组件无需手动同步。

import React, { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../app/useFocusTrap';
import { ENTITY_CARD_TYPES, type EntityCardType } from '../app/memorySchema';
import { ENTITY_CARD_TYPE_LABELS } from '../app/entityCardOps';

// 表单可编辑字段（不含 id/order/activeState/时间戳——那些由写库方按 AC2/AC3 处理）。
export interface EntityCardFormData {
  type: EntityCardType;
  name: string;
  summary: string;
  details: string;
}

interface EntityCardEditorProps {
  open: boolean;
  mode: 'create' | 'edit';
  initial: EntityCardFormData; // 编辑时回填当前卡；新建时给默认 type + 空字段
  onClose: () => void;
  onSubmit: (data: EntityCardFormData) => void;
}

export default function EntityCardEditor({ open, mode, initial, onClose, onSubmit }: EntityCardEditorProps) {
  const [type, setType] = useState<EntityCardType>(initial.type);
  const [name, setName] = useState(initial.name);
  const [summary, setSummary] = useState(initial.summary);
  const [details, setDetails] = useState(initial.details);
  const dialogRef = useRef<HTMLDivElement>(null);

  // open 切换时回填 / 重置（依赖原始「字段值」而非 initial 对象身份——父级每帧新建对象字面量也不会误触发重置，
  // 故用户键入不会被冲掉；仅在打开 / 切换目标卡时刷新）。仿 AppDialog 的 useEffect([open, initialValue])。
  useEffect(() => {
    if (open) {
      setType(initial.type);
      setName(initial.name);
      setSummary(initial.summary);
      setDetails(initial.details);
    }
  }, [open, initial.type, initial.name, initial.summary, initial.details]);

  // 焦点陷阱：打开移焦入对话框（优先首个文本控件 = 名称）、Tab 循环不逃逸、关闭归还焦点。
  useFocusTrap(dialogRef, open);

  // Esc 关闭（各模态保留自有 Esc 逻辑，与 AppDialog 一致）。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0; // 名称去空白后非空才可保存（AC3/AC5）
  const title = mode === 'create' ? '新增设定卡' : '编辑设定卡';

  function handleSubmit() {
    if (!canSave) return;
    onSubmit({ type, name: trimmedName, summary: summary.trim(), details: details.trim() });
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button type="button" className="absolute inset-0 bg-scrim" onClick={onClose} aria-label="关闭对话框" tabIndex={-1} />
      <div ref={dialogRef} className="glass pop-enter relative w-full max-w-[480px] rounded-lg p-5 shadow-pop">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>

        <div className="mt-4 space-y-4">
          {/* 名称（必填） */}
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="entity-card-name">名称</label>
            <input
              id="entity-card-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault(); // Enter 直接保存（textarea 不挂此 handler，故仍可换行）
                  handleSubmit();
                }
              }}
              placeholder="例如：灵气复苏纪元"
              className="input"
            />
          </div>

          {/* 类型（四选一；新建按入口默认、可改，编辑回填当前值） */}
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="entity-card-type">类型</label>
            <select
              id="entity-card-type"
              value={type}
              onChange={(e) => setType(e.target.value as EntityCardType)}
              className="input"
            >
              {ENTITY_CARD_TYPES.map((t) => (
                <option key={t} value={t}>{ENTITY_CARD_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>

          {/* 简述 */}
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="entity-card-summary">简述</label>
            <textarea
              id="entity-card-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="一句话点明这张设定卡的核心。"
              className="input"
              rows={2}
            />
          </div>

          {/* 详细设定（较高） */}
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="entity-card-details">详细设定</label>
            <textarea
              id="entity-card-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="展开规则、来历、关系与约束，供后续 AI 起草装配上下文。"
              className="input min-h-[120px]"
              rows={5}
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">取消</button>
          <button onClick={handleSubmit} disabled={!canSave} className="btn btn-primary">保存</button>
        </div>
      </div>
    </div>
  );
}
