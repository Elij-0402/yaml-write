'use client';

import { Dna, Library, PanelLeftClose, PanelLeftOpen, PenLine, Search, Settings } from 'lucide-react';

type Section = 'library' | 'creations';

// Linear 风图标导航轨（52px 纯图标）：品牌 → 搜索/命令面板入口（⌘K）→ 目的地（当前态 = 中性 raised，不用蓝）
// → 底部 侧栏折叠开关 + 设置 + 模型就绪点。标签改为图标 + title/aria-label。移动端为抽屉 + scrim（行为保留）。
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
  sidebarCollapsed,
  onToggleSidebar,
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
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
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
        } w-[52px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-3 lg:static lg:z-auto lg:flex`}
      >
        {/* 品牌 */}
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-fg text-canvas" title="创作 DNA 工坊">
          <Dna size={15} />
        </span>

        {/* 搜索 / 命令面板入口（⌘K） */}
        <button
          type="button"
          onClick={onOpenPalette}
          title="搜索或跳转（⌘K）"
          aria-label="搜索或跳转，快捷键 ⌘K"
          className="mt-2 grid h-9 w-9 place-items-center rounded-sm text-fg-subtle transition-colors hover:bg-raised hover:text-fg"
        >
          <Search size={16} />
        </button>

        {/* 主导航：图标 + 角标计数，当前态 = 中性 raised（不用蓝） */}
        <nav className="mt-1 flex flex-1 flex-col items-center gap-1" aria-label="主导航">
          {items.map(({ id, label, Icon, count }) => {
            const active = activeSection === id;
            return (
              <button
                key={id}
                onClick={() => onSelectSection(id)}
                title={label}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                className={`relative grid h-9 w-9 place-items-center rounded-sm transition-colors ${
                  active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised hover:text-fg'
                }`}
              >
                <Icon size={18} />
                {count > 0 && (
                  <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full border border-line bg-surface px-1 font-mono text-[9px] leading-none text-fg-subtle tabular-nums">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* 侧栏折叠开关（AC6：折叠/展开切换 + aria-expanded） */}
        <button
          type="button"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? '展开侧栏（⌘\\）' : '折叠侧栏（⌘\\）'}
          aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
          aria-expanded={!sidebarCollapsed}
          className="grid h-9 w-9 place-items-center rounded-sm text-fg-subtle transition-colors hover:bg-raised hover:text-fg"
        >
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>

        {/* 设置 + 模型就绪点 */}
        <button
          onClick={onOpenSettings}
          title="设置"
          aria-label="设置"
          className="relative grid h-9 w-9 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-raised hover:text-fg"
        >
          <Settings size={18} />
          <span
            className={`absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ${readinessOk ? 'bg-success' : 'bg-fg-subtle'}`}
            title={readinessOk ? '模型已连接' : '模型待配置'}
          />
        </button>
      </aside>
    </>
  );
}
