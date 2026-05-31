import "./globals.css";

export const metadata = {
  title: "小说解析与创意融合助手",
  description: "导入小说、结构化解析章节、横向对比并融合生成新大纲与正文",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
