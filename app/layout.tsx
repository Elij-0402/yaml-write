import "./globals.css";

export const metadata = {
  title: "创作 DNA 工坊",
  description: "选两本写完的书——一本当骨架、一本换题材——一键生成形似神不似的新书开篇。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
