import "./globals.css";

export const metadata = {
  title: "创作 DNA 工坊",
  description: "选两本写完的书——一本当骨架、一本换题材——一键生成形似神不似的新书开篇。",
};

// 首帧前解析主题（与 app/theme.ts 同一套规则），避免亮色用户看到暗色闪烁。
// 默认暗色优先：偏好缺失时跟随系统，探测失败落暗色。
const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem('va-theme');var t=(p==='light'||p==='dark')?p:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

// 首帧前解析「侧栏折叠态」（Story 1.1 评审 #2）：注水前 React 用默认（展开）渲染，持久折叠的用户会先看到
// 侧栏闪现再瞬收（明显 layout shift）。这里在首帧前按持久值给 <html> 加 .va-sidebar-collapsed，配合 globals.css
// 末尾的非分层规则把侧栏压成 0；page.tsx 注水后移除该类、交还 React inline 控制。读 zustand persist 的 'novel-fusion-store'
// （layout.sidebarCollapsed 为明文，未经 apiKey 混淆）。<html suppressHydrationWarning> 已设，类差异不触发水合告警。
const LAYOUT_BOOTSTRAP = `(function(){try{var s=localStorage.getItem('novel-fusion-store');if(!s)return;var l=JSON.parse(s).state.layout;if(l&&l.sidebarCollapsed===true)document.documentElement.classList.add('va-sidebar-collapsed');}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <script dangerouslySetInnerHTML={{ __html: LAYOUT_BOOTSTRAP }} />
        {children}
      </body>
    </html>
  );
}
