import "./globals.css";

export const metadata = {
  title: "创作 DNA 工坊",
  description: "从长篇小说提炼创作骨架，支持多作品融合创作",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="bg-[#0a0a0a]">
      <body className="antialiased">{children}</body>
    </html>
  );
}
