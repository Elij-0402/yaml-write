'use client';

import { Dna, Library, PenLine, Search, Settings } from 'lucide-react';

type Section = 'library' | 'creations';

// Linear 风侧栏（224px）：品牌 → 搜索/命令面板入口（⌘K）→ 目的地（当前态 = 中性 raised，不用蓝）
// → 底部设置 + 模型就绪点。移动端为抽屉 + scrim。
export default function AppRail({
  activeSection,
  onSelectSection,
  onOpenSettings,
  onOpenPalette,
  readinessOk,
  novelCount,
  creationCount,
  mobileOpen,
  onCloseMobile,
}: {
  activeSection: Section;
  onSelectSection: (section: Section) => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  readinessOk: boolean;
  novelCount: number;
  creationCount: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const items: { id: Section; label: string; Icon: typeof Library; count: number }[] = [
    { id: 'library', label: '作品库', Icon: Library, count: novelCount },
    { id: 'creations', label: '创作库', Icon: PenLine, count: creationCount },
  ];

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          onClick={onCloseMobile}
          className="fixed inset-0 z-30 bg-scrim lg:hidden"
        />
      )}

      <aside
        className={`${
          mobileOpen ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden'
        } w-[224px] shrink-0 flex-col border-r border-line bg-panel lg:static lg:z-auto lg:flex`}
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 px-3.5">
          <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md bg-fg text-canvas">
            <Dna size={14} />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold text-fg">创作 DNA 工坊</div>
            <div className="truncate font-mono text-[9.5px] tracking-[0.13em] text-fg-subtle">VARIATION ATELIER</div>
          </div>
        </div>

        <div className="px-3 pb-1 pt-1.5">
          <button
            type="button"
            onClick={onOpenPalette}
            className="flex h-8 w-full items-center gap-2 rounded-sm border border-line bg-surface px-2.5 text-[12.5px] text-fg-subtle transition-colors hover:border-fg-subtle hover:text-fg-muted"
          >
            <Search size={13} className="shrink-0" />
            <span className="flex-1 text-left">搜索或跳转…</span>
            <span className="kbd">⌘K</span>
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 p-3 pt-2" aria-label="主导航">
          {items.map(({ id, label, Icon, count }) => {
            const active = activeSection === id;
            return (
              <button
                key={id}
                onClick={() => onSelectSection(id)}
                aria-current={active ? 'page' : undefined}
                className={`flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-[13px] font-medium transition-colors ${
                  active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised hover:text-fg'
                }`}
              >
                <Icon size={15} className={`shrink-0 ${active ? 'text-fg' : 'text-fg-subtle'}`} />
                <span className="flex-1 text-left">{label}</span>
                {count > 0 && <span className="font-mono text-[11px] tabular-nums text-fg-subtle">{count}</span>}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-line p-3">
          <button
            onClick={onOpenSettings}
            className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-[13px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
          >
            <Settings size={15} className="shrink-0 text-fg-subtle" />
            <span className="flex-1 text-left">设置</span>
            <span
              className={`h-1.5 w-1.5 rounded-full ${readinessOk ? 'bg-success' : 'bg-fg-subtle'}`}
              title={readinessOk ? '模型已连接' : '模型待配置'}
            />
          </button>
        </div>
      </aside>
    </>
  );
}
