'use client';

// 28px 底部连通状态栏（UX「版本控制条」的最小落地——本故事仅承载「在线 / 离线模式」连通段）。
// 纯展示：isOffline 由 page.tsx 传入，便于复用与心智简单。草稿版本标签 / IndexedDB 延迟等其余段
// 属 Epic 4 / 未来，右侧留空位、不臆造。视觉铁律：离线为功能性 danger（红点 + 红字），
// 在线为 idle/ready 的中性灰点（不铺绿）；图标仅用 lucide-react，零 Emoji。
import { Wifi, WifiOff } from 'lucide-react';
import { deriveConnectivity } from '../app/networkStatus';

export default function StatusBar({ isOffline }: { isOffline: boolean }) {
  const { label } = deriveConnectivity(isOffline);
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-[11px]">
      {/* 连通段：状态切换时朗读（无障碍 UX-DR7）。 */}
      <span className="flex items-center gap-1.5" aria-live="polite">
        <span className={`h-1.5 w-1.5 rounded-full ${isOffline ? 'bg-danger' : 'bg-fg-subtle'}`} />
        {isOffline ? <WifiOff size={14} className="text-danger" /> : <Wifi size={14} className="text-fg-muted" />}
        <span className={isOffline ? 'text-danger' : 'text-fg-muted'}>{label}</span>
      </span>
      {/* 右侧留空：草稿版本标签 / IndexedDB 延迟为 Epic 4 / 未来，本故事不渲染。 */}
      <span aria-hidden />
    </footer>
  );
}
