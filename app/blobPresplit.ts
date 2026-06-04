// 超长 blob 章节的「纯预切」层：盗版 txt 常把整本/多章塞进一个几万字的单章（章节标记没被识别），
// 该 blob 会成为一个超大弧窗被后端 extract-arc-map 静默砍尾（content[:MAX_ARC_CONTENT_CHARS]），
// 且触发 splitQuality 的「超大章节」(maxChapterRatio≥0.82) → needs_review，把 DNA 闸门误锁。
// 这里在落盘前把超阈值章节按「行/段落边界」切成 ≤ target 的若干片：纯函数、无 db/crypto，
// 组件拿结果落盘并补算 sha + rescoreSplit。由 blobPresplit.test.ts 守护下标/边界算术。
//
// 阈值取舍：只切「真·超长 blob」(≥24k≈弧窗预算)，正常长章(12k–24k)不动，避免过度碎片化；
// 单片目标 12k —— 两片仍可被 buildArcWindows 合进一个 24k 窗，且远低于后端 48k 上限（DeepSeek 64K ctx 安全）。

import type { ParsedChapter } from './novelParser';

export const BLOB_CHAR_THRESHOLD = 24000; // 仅超过此长度的章节才预切
export const PRESPLIT_TARGET_CHARS = 12000; // 预切后单片字数上限

export interface BlobPresplitResult {
  chapters: ParsedChapter[];
  didSplit: boolean;
  splitChapterCount: number; // 被预切的原始章节数（非产出片数），供组件提示「N 个超长章节已自动切分」
}

// 按行边界把一章正文打包成每片 ≤ target 的片；单行本身超 target（无换行的大段）时按字符硬切，
// 保证每片 ≤ target。空白片丢弃。
function splitByLineBudget(content: string, target: number): string[] {
  const segments: string[] = [];
  for (const line of content.split('\n')) {
    if (line.length <= target) {
      segments.push(line);
    } else {
      for (let i = 0; i < line.length; i += target) segments.push(line.slice(i, i + target));
    }
  }

  const pieces: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length === 0) return;
    const text = cur.join('\n').trim();
    if (text) pieces.push(text);
    cur = [];
    curLen = 0;
  };
  for (const seg of segments) {
    const segLen = seg.length + 1; // +换行
    if (cur.length > 0 && curLen + segLen > target) flush();
    cur.push(seg);
    curLen += segLen;
  }
  flush();
  return pieces;
}

export function planBlobPresplit(
  chapters: ReadonlyArray<ParsedChapter>,
  opts: { thresholdChars?: number; targetChars?: number } = {},
): BlobPresplitResult {
  const threshold = opts.thresholdChars ?? BLOB_CHAR_THRESHOLD;
  const target = opts.targetChars ?? PRESPLIT_TARGET_CHARS;

  const out: ParsedChapter[] = [];
  let didSplit = false;
  let splitChapterCount = 0;

  for (const ch of chapters) {
    const len = ch.wordCount || ch.content.length;
    if (len <= threshold) {
      out.push(ch);
      continue;
    }
    const pieces = splitByLineBudget(ch.content, target);
    if (pieces.length <= 1) {
      out.push(ch); // 切不开（如整章一行且 ≤target 的退化情形）：原样保留，不丢 sha
      continue;
    }
    didSplit = true;
    splitChapterCount += 1;
    for (let i = 0; i < pieces.length; i += 1) {
      out.push({
        chapterIndex: 0, // 占位，下方统一重排
        title: i === 0 ? ch.title : `${ch.title}（${i + 1}）`,
        content: pieces[i],
        wordCount: pieces[i].length,
        // contentSha256 故意不带：片段内容已变，交由组件落盘时补算
      });
    }
  }

  // 统一按输出顺序重排 chapterIndex 1..N（与 worker / chapterOps 的 1 基约定一致）；产出新对象，不改入参。
  return {
    chapters: out.map((c, i) => ({ ...c, chapterIndex: i + 1 })),
    didSplit,
    splitChapterCount,
  };
}
