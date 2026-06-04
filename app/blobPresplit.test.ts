import { describe, it, expect } from 'vitest';
import { planBlobPresplit, BLOB_CHAR_THRESHOLD, PRESPLIT_TARGET_CHARS } from './blobPresplit';
import type { ParsedChapter } from './novelParser';

function ch(chapterIndex: number, title: string, content: string): ParsedChapter {
  return { chapterIndex, title, content, wordCount: content.length };
}

// 造一段含换行的指定字数正文（每行 ~50 字，便于按行切）。
function makeText(chars: number): string {
  const line = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰';
  const lines: string[] = [];
  let total = 0;
  while (total < chars) {
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n').slice(0, chars);
}

describe('planBlobPresplit', () => {
  it('正常章节（均 ≤ 阈值）原样保留，didSplit=false，下标 1..N', () => {
    const input = [ch(1, '第一章', makeText(3000)), ch(2, '第二章', makeText(5000)), ch(3, '第三章', makeText(2000))];
    const r = planBlobPresplit(input);
    expect(r.didSplit).toBe(false);
    expect(r.splitChapterCount).toBe(0);
    expect(r.chapters).toHaveLength(3);
    expect(r.chapters.map((c) => c.chapterIndex)).toEqual([1, 2, 3]);
    expect(r.chapters.map((c) => c.title)).toEqual(['第一章', '第二章', '第三章']);
  });

  it('超长 blob 被切成多片，每片 ≤ target，首片留原名、后续带（n）', () => {
    const blob = makeText(50000);
    const r = planBlobPresplit([ch(1, '全本', blob)]);
    expect(r.didSplit).toBe(true);
    expect(r.splitChapterCount).toBe(1);
    expect(r.chapters.length).toBeGreaterThan(1);
    for (const c of r.chapters) expect(c.wordCount).toBeLessThanOrEqual(PRESPLIT_TARGET_CHARS);
    expect(r.chapters[0].title).toBe('全本');
    expect(r.chapters[1].title).toBe('全本（2）');
  });

  it('混合：blob 与正常章共存，下标整体重排 1..N，正常章不动', () => {
    const input = [ch(1, '短章A', makeText(2000)), ch(2, '巨章', makeText(40000)), ch(3, '短章B', makeText(2000))];
    const r = planBlobPresplit(input);
    expect(r.didSplit).toBe(true);
    expect(r.splitChapterCount).toBe(1);
    // 首尾短章保留，中间 blob 展开为多片
    expect(r.chapters[0].title).toBe('短章A');
    expect(r.chapters[r.chapters.length - 1].title).toBe('短章B');
    expect(r.chapters.map((c) => c.chapterIndex)).toEqual(
      Array.from({ length: r.chapters.length }, (_, i) => i + 1),
    );
  });

  it('阈值边界：恰好 ≤ 阈值不切，超过才切', () => {
    expect(planBlobPresplit([ch(1, 'A', makeText(BLOB_CHAR_THRESHOLD))]).didSplit).toBe(false);
    expect(planBlobPresplit([ch(1, 'A', makeText(BLOB_CHAR_THRESHOLD + 2000))]).didSplit).toBe(true);
  });

  it('病态超长单行（无换行大段）仍保证每片 ≤ target', () => {
    const oneLine = '字'.repeat(40000); // 无任何换行
    const r = planBlobPresplit([ch(1, '一行流', oneLine)]);
    expect(r.didSplit).toBe(true);
    expect(r.chapters.length).toBeGreaterThan(1);
    for (const c of r.chapters) expect(c.content.length).toBeLessThanOrEqual(PRESPLIT_TARGET_CHARS);
  });

  it('不改入参对象（纯函数）', () => {
    const input = [ch(1, '巨章', makeText(40000))];
    const before = input[0].chapterIndex;
    planBlobPresplit(input);
    expect(input[0].chapterIndex).toBe(before);
    expect(input).toHaveLength(1);
  });
});
