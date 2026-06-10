import "./globals.css";

export const metadata = {
  title: "创作 DNA 工坊",
  description: "选两本写完的书——一本当骨架、一本换题材——一键生成形似神不似的新书开篇。",
};

// 首帧前解析主题（与 app/theme.ts 同一套规则），避免亮色用户看到暗色闪烁。
// 默认暗色优先：偏好缺失时跟随系统，探测失败落暗色。
const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem('va-theme');var t=(p==='light'||p==='dark')?p:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
      </body>
    </html>
  );
}
