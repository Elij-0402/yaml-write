// 共享小工具：内容指纹 + 字数格式化。
// 此前 sha256 在 dnaEngine / NovelUploader（+LibraryView 死副本）各抄一份；
// formatWordCount 在 4 个组件各抄一份。统一到此处，勿再回抄。

export async function sha256Hex(text: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 裸字数：≥1万显示「1.2万」，否则原数。调用处自行加「字」后缀。
export function formatWordCount(count: number): string {
  return count >= 10000 ? `${(count / 10000).toFixed(1)}万` : `${count}`;
}
