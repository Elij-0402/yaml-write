import type { Novel, MapStatus } from './db';

// 「这本书 DNA 处于什么阶段」的单一事实源：纯只读判定/投影，无 React / Dexie / 网络依赖。
// 此前散落各处内联手抄的状态字符串比较（侧栏就绪计数、配方台挑选、WorkflowStepper 投影、
// 首页阶段派生、重切「提取中禁止」防护）一律改调本模块。

// 只读「提取状态」所需的最小结构子集：状态字符串 + DNA 卡是否存在（仅判定 presence，不关心卡内部形状）。
// 任意 Novel 结构上即满足；纯单测也可直接构造，无需造完整卡。
type ExtractionState = Pick<Novel, 'analysisStatus'> & { dnaCard?: unknown };

// 提取阶段四态——UI（侧栏状态点、WorkflowStepper、DNA 板）消费的收敛投影。
export type DnaPhase = 'idle' | 'extracting' | 'ready' | 'error';

// reconcile（崩溃/刷新复位）计划：把 analysisStatus 退回 idle，并把这些章节（卡在 mapping 的）退回 pending。
export interface ReconcilePlan {
  nextAnalysisStatus: 'idle';
  resetChapterIds: string[];
}

// 「已就绪」⇔ 全书归纳完成（done）且确有 DNA 卡落库。
export function isDnaReady(novel: ExtractionState | null | undefined): boolean {
  return !!novel && novel.analysisStatus === 'done' && !!novel.dnaCard;
}

// 「提取中」⇔ 正在逐章 Map（mapping）或归纳 Reduce（reducing）。
export function isExtracting(novel: ExtractionState | null | undefined): boolean {
  return !!novel && (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing');
}

// 阶段投影：把原始 analysisStatus 收敛为 UI 关心的四态（mapping/reducing 合并为 extracting）。
// 退化态（done 无卡、idle 有卡等不可达组合）一律落 'idle'。
export function dnaPhase(novel: ExtractionState | null | undefined): DnaPhase {
  if (isExtracting(novel)) return 'extracting';
  if (isDnaReady(novel)) return 'ready';
  if (novel && novel.analysisStatus === 'error') return 'error';
  return 'idle';
}

// 后台自启「状态层」门：仅当书是全新 idle（既没在跑、没出错、也没结果卡）时才允许后台自动起跑。
// 调用方（useBackgroundExtraction）另持 split-OK / 配置清白 / single-flight 等附加门——本判定只管状态那一截。
// 关键不变量：error 的书绝不被自动重启（保持可见 + 手动重试入口）；已有 dnaCard 的 idle 书走手动「重新提取」。
export function canAutoStart(novel: ExtractionState | null | undefined): boolean {
  return !!novel && novel.analysisStatus === 'idle' && !novel.dnaCard;
}

// 续跑目标选择（统一不变量的「前向一半」）：从规划出的弧窗中，恰好剔除 lead 章已 mapStatus==='done' 的窗口。
// 纯函数——运行器据此跳过已映射完成的弧窗，不重做、不浪费 API 配额。lead 不在查表中视为未 done（仍是待跑目标）。
// 仅读 unit.id（lead chapter id），故对任意带 id 的 unit 形状泛化，与 dnaRouting.ExtractionUnit 解耦。
export function selectResumeTargets<U extends { id: string }>(
  units: readonly U[],
  chaptersById: ReadonlyMap<string, { mapStatus: MapStatus }>,
): U[] {
  return units.filter((u) => chaptersById.get(u.id)?.mapStatus !== 'done');
}

// reconcile 复位计划（统一不变量的「后向一半」，self-heal）：纯函数。
// 核心断言——书状态为 extracting（mapping/reducing）却无在跑任务时，视为被刷新/崩溃滞留 ⇒ 复位 idle、
// 把卡在 mapping 的章节退回 pending（done 章节不动，确保后续续跑跳过它们）。非 extracting（idle/done/error）⇒ null。
// 与 selectResumeTargets 共用 isExtracting 判定，故前向（resume 跳 done）与后向（reset mapping→pending）无法独立漂移。
export function planReconcile(
  novel: ExtractionState | null | undefined,
  chapters: readonly { id: string; mapStatus: MapStatus }[],
): ReconcilePlan | null {
  if (!isExtracting(novel)) return null;
  return {
    nextAnalysisStatus: 'idle',
    resetChapterIds: chapters.filter((c) => c.mapStatus === 'mapping').map((c) => c.id),
  };
}
