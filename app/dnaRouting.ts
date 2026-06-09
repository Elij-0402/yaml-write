// 按体量自适应的 DNA 提取路由（纯函数，无 Dexie/网络依赖；在 dnaRouting.test.ts 以 node 环境单测）。
// 用户零参数：仅凭净化字数自动选路。dnaEngine.ts 据此选取「整本直提 / 弧窗逐组 / 饱和采样」。

export type ExtractionRoute = 'direct' | 'arc' | 'sampling';

// 体量阈值（净化字数 = novel.wordCount / sourceTextCleaned.length）：
//   小 ≲ 18 万   → direct  （整本单次长上下文，跳过逐章 map）
//   中 18万–200万 → arc     （按字数预算分弧窗，逐窗 map，覆盖全书）
//   大 ≳ 200 万   → sampling（在全部弧窗里均匀采样，收敛即停，避免上千章卡死）
export const SMALL_MAX_CHARS = 180_000;
export const ARC_MAX_CHARS = 2_000_000;

// 弧窗字数预算：单窗拼接文本上限（须 ≤ 后端 extract-arc-map 的 MAX_ARC_CONTENT_CHARS）。
export const ARC_WINDOW_BUDGET_CHARS = 24_000;
// 饱和采样窗口上限：大书最多实测这么多窗，跨全书均匀铺开（含开篇与尾段）。
export const SAMPLE_WINDOW_CAP = 48;
// 超大单章告警阈值 = 后端单弧窗上限 MAX_ARC_CONTENT_CHARS / dnaEngine MAX_ARC_INPUT_CHARS。
// 超过此值的单章在弧窗 map 时尾部才会被截断（dnaEngine 会 console.warn），UI 据此提示先裁切——
// 与真实截断阈值同源，避免再出现「警告会截断但实际不截断」的 30k/48k 漂移。
export const OVERSIZED_CHAPTER_CHARS = 48_000;

export function routeBySize(wordCount: number): ExtractionRoute {
  if (!Number.isFinite(wordCount) || wordCount <= SMALL_MAX_CHARS) return 'direct';
  if (wordCount <= ARC_MAX_CHARS) return 'arc';
  return 'sampling';
}

export interface ChapterLite {
  id: string;
  name: string;
  wordCount: number;
}

// 一个提取单元 = 一个弧窗：覆盖若干连续章节，由 lead 章（首章）作为 worker 去重 / 持久化键。
export interface ExtractionUnit {
  id: string;           // lead chapter id
  chapterIds: string[]; // 本窗覆盖的全部章节 id（含 lead）
  label: string;        // 人类可读标签
}

// 按字数预算把连续章节聚成弧窗：累计字数超预算即开新窗；单章即便超预算也自成一窗（至少 1 章）。
export function buildArcWindows(chapters: ChapterLite[], budgetChars: number): ExtractionUnit[] {
  const budget = budgetChars > 0 ? budgetChars : ARC_WINDOW_BUDGET_CHARS;
  const units: ExtractionUnit[] = [];
  let cur: ChapterLite[] = [];
  let curChars = 0;

  const flush = () => {
    if (cur.length === 0) return;
    units.push({
      id: cur[0].id,
      chapterIds: cur.map((c) => c.id),
      label: cur.length === 1 ? cur[0].name : `${cur[0].name} 等 ${cur.length} 章`,
    });
    cur = [];
    curChars = 0;
  };

  for (const ch of chapters) {
    const w = Math.max(0, ch.wordCount || 0);
    if (cur.length > 0 && curChars + w > budget) flush();
    cur.push(ch);
    curChars += w;
  }
  flush();
  return units;
}

// 在全部弧窗里均匀采样：window 数 ≤ cap 时全取；否则必含首尾，中间按等距步长抽取，保持原序、去重。
export function selectSampledWindows(windows: ExtractionUnit[], cap: number): ExtractionUnit[] {
  if (cap <= 0) return [];
  if (windows.length <= cap) return windows;
  if (cap === 1) return [windows[0]];

  const picked = new Set<number>();
  picked.add(0);
  picked.add(windows.length - 1);
  const inner = cap - 2; // 头尾各占 1
  if (inner > 0) {
    const stride = (windows.length - 1) / (inner + 1);
    for (let k = 1; k <= inner; k += 1) {
      picked.add(Math.round(k * stride));
    }
  }
  return Array.from(picked).sort((a, b) => a - b).map((i) => windows[i]);
}

// 据路由产出待测序的弧窗列表。direct 不走逐窗 map（返回空）；arc 取全部窗；sampling 取均匀采样子集。
export function planExtractionUnits(
  chapters: ChapterLite[],
  route: ExtractionRoute,
  opts: { budgetChars?: number; sampleCap?: number } = {},
): ExtractionUnit[] {
  if (route === 'direct') return [];
  const windows = buildArcWindows(chapters, opts.budgetChars ?? ARC_WINDOW_BUDGET_CHARS);
  if (route === 'sampling') return selectSampledWindows(windows, opts.sampleCap ?? SAMPLE_WINDOW_CAP);
  return windows;
}
