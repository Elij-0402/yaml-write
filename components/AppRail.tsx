'use client';

import { Dna, Library, Sparkles, Settings } from 'lucide-react';

type Section = 'library' | 'creations';

export default function AppRail({
  activeSection,
  onSelectSection,
  onOpenSettings,
  readinessOk,
  novelCount,
  creationCount,
  mobileOpen,
  onCloseMobile,
}: {
  activeSection: Section;
  onSelectSection: (section: Section) => void;
  onOpenSettings: () => void;
  readinessOk: boolean;
  novelCount: number;
  creationCount: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const items: { id: Section; label: string; Icon: typeof Library; count: number }[] = [
    { id: 'library', label: '作品库', Icon: Library, count: novelCount },
    { id: 'creations', label: '创作库', Icon: Sparkles, count: creationCount },
  ];

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          onClick={onCloseMobile}
          className="fixed inset-0 z-30 bg-fg/45 lg:hidden"
        />
      )}

      <aside
        className={`${
          mobileOpen ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden'
        } w-[232px] shrink-0 flex-col border-r border-line bg-panel lg:static lg:z-auto lg:flex`}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-fg text-canvas">
            <Dna size={16} />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-fg">创作 DNA 工坊</div>
            <div className="font-mono text-[10px] tracking-[0.14em] text-fg-subtle">VARIATION ATELIER</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3" aria-label="主导航">
          {items.map(({ id, label, Icon, count }) => {
            const active = activeSection === id;
            return (
              <button
                key={id}
                onClick={() => onSelectSection(id)}
                aria-current={active ? 'page' : undefined}
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                  active ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:bg-raised hover:text-fg'
                }`}
              >
                <Icon size={16} className="shrink-0" />
                <span className="flex-1 text-left font-medium">{label}</span>
                {count > 0 && (
                  <span className={`font-mono text-xs tabular-nums ${active ? 'text-accent' : 'text-fg-subtle'}`}>{count}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-line p-3">
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-raised hover:text-fg"
          >
            <Settings size={16} className="shrink-0" />
            <span className="flex-1 text-left font-medium">设置</span>
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
