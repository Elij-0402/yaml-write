'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, Library, Monitor, Moon, PenLine, Plus, Search, Settings, Sun } from 'lucide-react';
import { db, type FusionSession, type Novel } from '../app/db';
import { isDnaReady } from '../app/dnaState';
import { useAppStore } from '../app/store';
import { useFocusTrap } from '../app/useFocusTrap';
import { getStoredThemePreference, setThemePreference, type ThemePreference } from '../app/theme';

type Section = 'library' | 'creations';

interface CommandEntry {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords: string;
  Icon: typeof Search;
  disabled?: boolean;
  disabledReason?: string;
  run: () => void;
}

const THEME_OPTIONS: { pref: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { pref: 'system', label: '主题 · 跟随系统', Icon: Monitor },
  { pref: 'light', label: '主题 · 亮色', Icon: Sun },
  { pref: 'dark', label: '主题 · 暗色', Icon: Moon },
];

// ⌘K 命令面板：跳转 / 打开作品 / 打开创作 / 新建创作 / 主题 / 设置。
// 键盘：↑↓ 选择（跳过禁用项）、Enter 执行、Esc 关闭；列表项 hover 同步高亮。
export default function CommandPalette({
  open,
  onClose,
  onSelectSection,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  onSelectSection: (section: Section) => void;
  onOpenSettings: () => void;
}) {
  const { setSelectedNovelId, setActiveCreationId, workshopBusy } = useAppStore((s) => ({
    setSelectedNovelId: s.setSelectedNovelId,
    setActiveCreationId: s.setActiveCreationId,
    workshopBusy: s.workshopBusy,
  }));

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open);

  const novelsRaw = useLiveQuery<Novel[]>(() => db.novels.orderBy('createdAt').reverse().toArray(), []);
  const creationsRaw = useLiveQuery<FusionSession[]>(() => db.fusionSessions.orderBy('updatedAt').reverse().toArray(), []);
  const novels = useMemo(() => novelsRaw || [], [novelsRaw]);
  const creations = useMemo(
    () => (creationsRaw || []).filter(
      (c) => c.step === 'creator' || c.step === 'manuscript' || Object.keys(c.sceneTexts || {}).length > 0,
    ),
    [creationsRaw],
  );
  const readyCount = useMemo(() => novels.filter((n) => isDnaReady(n)).length, [novels]);
  const themePref = open ? getStoredThemePreference() : 'system';

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
    }
  }, [open]);

  const entries = useMemo<CommandEntry[]>(() => {
    if (!open) return [];
    const list: CommandEntry[] = [
      {
        id: 'nav-library', group: '跳转', label: '前往作品库', keywords: '作品库 library 书架 导入',
        Icon: Library, run: () => onSelectSection('library'),
      },
      {
        id: 'nav-creations', group: '跳转', label: '前往创作库', keywords: '创作库 creations 工坊 studio',
        Icon: PenLine, run: () => onSelectSection('creations'),
      },
      {
        id: 'act-new-creation', group: '操作', label: '新建创作',
        keywords: '新建 创作 new creation 换皮 开始',
        Icon: Plus,
        disabled: readyCount < 1 || workshopBusy,
        disabledReason: workshopBusy ? '生成进行中' : '需先有 DNA 就绪的作品',
        run: () => setActiveCreationId(crypto.randomUUID()),
      },
      {
        id: 'act-settings', group: '操作', label: '打开设置', hint: '⌘,',
        keywords: '设置 settings 模型 密钥 api key provider',
        Icon: Settings, run: () => onOpenSettings(),
      },
    ];

    const cap = query.trim() ? Infinity : 6;
    novels.slice(0, cap === Infinity ? novels.length : cap).forEach((n) => {
      list.push({
        id: `novel-${n.id}`, group: '作品', label: n.name,
        hint: isDnaReady(n) ? 'DNA 就绪' : undefined,
        keywords: `作品 novel ${n.name}`,
        Icon: BookOpen, run: () => setSelectedNovelId(n.id),
      });
    });
    creations.slice(0, cap === Infinity ? creations.length : cap).forEach((c) => {
      const name = c.name || c.directionTitle || '未命名创作';
      list.push({
        id: `creation-${c.id}`, group: '创作', label: name,
        keywords: `创作 creation ${name}`,
        Icon: PenLine,
        disabled: workshopBusy,
        disabledReason: '生成进行中，暂不能切换创作',
        run: () => setActiveCreationId(c.id),
      });
    });

    THEME_OPTIONS.forEach(({ pref, label, Icon }) => {
      list.push({
        id: `theme-${pref}`, group: '主题', label,
        hint: themePref === pref ? '当前' : undefined,
        keywords: `主题 theme 外观 ${pref} 暗色 亮色 dark light system`,
        Icon, run: () => setThemePreference(pref),
      });
    });

    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) => e.label.toLowerCase().includes(q) || e.keywords.toLowerCase().includes(q));
  }, [open, query, novels, creations, readyCount, workshopBusy, themePref, onSelectSection, onOpenSettings, setActiveCreationId, setSelectedNovelId]);

  const enabledIdx = useMemo(() => entries.map((e, i) => (e.disabled ? -1 : i)).filter((i) => i >= 0), [entries]);

  useEffect(() => {
    // 过滤结果变化后把高亮收敛到首个可用项。
    setActiveIdx((prev) => (entries[prev] && !entries[prev].disabled ? prev : enabledIdx[0] ?? 0));
  }, [entries, enabledIdx]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  const move = (delta: 1 | -1) => {
    if (enabledIdx.length === 0) return;
    const pos = enabledIdx.indexOf(activeIdx);
    const next = pos === -1 ? 0 : (pos + delta + enabledIdx.length) % enabledIdx.length;
    setActiveIdx(enabledIdx[next]);
  };

  const execute = (entry: CommandEntry | undefined) => {
    if (!entry || entry.disabled) return;
    onClose();
    entry.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); execute(entries[activeIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[15vh]" role="dialog" aria-modal="true" aria-label="命令面板">
      <button type="button" className="absolute inset-0 bg-scrim" onClick={onClose} aria-label="关闭命令面板" tabIndex={-1} />

      <div ref={containerRef} className="glass pop-enter relative w-full max-w-[560px] overflow-hidden rounded-lg shadow-pop">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={15} className="shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索作品、创作，或输入命令…"
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={entries[activeIdx] ? `cmd-${entries[activeIdx].id}` : undefined}
          />
          <span className="kbd">Esc</span>
        </div>

        <div ref={listRef} id="command-palette-list" role="listbox" aria-label="命令列表" className="max-h-[min(48vh,360px)] overflow-y-auto p-1.5">
          {entries.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-fg-subtle">没有匹配的结果</div>
          ) : (
            entries.map((entry, idx) => {
              const groupHeader = entry.group !== lastGroup ? entry.group : null;
              lastGroup = entry.group;
              const active = idx === activeIdx;
              return (
                <React.Fragment key={entry.id}>
                  {groupHeader && <div className="eyebrow px-2.5 pb-1 pt-2.5">{groupHeader}</div>}
                  <button
                    id={`cmd-${entry.id}`}
                    data-idx={idx}
                    role="option"
                    aria-selected={active}
                    disabled={entry.disabled}
                    title={entry.disabled ? entry.disabledReason : undefined}
                    onMouseEnter={() => { if (!entry.disabled) setActiveIdx(idx); }}
                    onClick={() => execute(entry)}
                    className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                      active ? 'bg-raised text-fg' : 'text-fg-muted'
                    }`}
                  >
                    <entry.Icon size={15} className="shrink-0 text-fg-subtle" />
                    <span className="min-w-0 flex-1 truncate text-left">{entry.label}</span>
                    {entry.disabled && entry.disabledReason
                      ? <span className="shrink-0 text-[11px] text-fg-subtle">{entry.disabledReason}</span>
                      : entry.hint && <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{entry.hint}</span>}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-fg-subtle">
          <span className="flex items-center gap-1.5"><span className="kbd">↑</span><span className="kbd">↓</span> 选择</span>
          <span className="flex items-center gap-1.5"><span className="kbd">↵</span> 执行</span>
        </div>
      </div>
    </div>
  );
}
