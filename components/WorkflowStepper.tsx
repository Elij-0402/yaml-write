'use client';

import { getStageStatusClasses, type WorkflowStage, type WorkflowSummary } from '../app/workflow';

const STATUS_DOT: Record<WorkflowStage['status'], string> = {
  done: 'bg-[color:var(--ink)]',
  running: 'bg-[color:var(--signal)]',
  ready: 'bg-[color:var(--faint)]',
  blocked: 'bg-[color:var(--faint)]', // 软门 = 前置条件，非错误（R2）：faint，不用 danger
  idle: 'bg-[color:var(--faint)]',
};

// 工序 handoff（IF-7）：每道工序「消费 → 产出」的产物。横读四卡即读工序链 txt → 原文 → 章节 → 4 层卡 → 开篇，
// 上下游依赖一眼可见（P2）。措辞用术语表词汇（原文 · 章节 · 4 层卡 · 开篇）。
const HANDOFF: Record<WorkflowStage['id'], string> = {
  import: 'txt → 原文',
  split: '原文 → 章节',
  dna: '章节 → 4 层卡',
  fusion: '4 层卡 → 开篇',
};

// 主线进度 Stepper：把 workflow.ts 里写好却从未被调用的 getNovelWorkflowSummary 变成顶部常驻导航，
// 用「阶段门」取代 page.tsx 三标志（workshopOpen/selectedNovelId/manageMode）的拼凑式切换。
// 工序条 = 4 卡网格「就地升级」：一行抬头 + 每卡 handoff 行 + 运行态着青。
// 「下一步」是单一权威出口（IF-8），落在 page.tsx 左栏行——stepper 不再重复 pill。
export default function WorkflowStepper({
  summary,
  currentStageId,
  onStageClick,
}: {
  summary: WorkflowSummary;
  currentStageId: WorkflowStage['id'] | null;
  onStageClick: (id: WorkflowStage['id']) => void;
}) {
  return (
    <nav className="space-y-4" aria-label="创作主线进度">
      <div className="eyebrow !mb-0">Workflow · 主线流程</div>
      <div className="grid gap-3 lg:grid-cols-4">
      {summary.stages.map((stage, idx) => {
        const active = stage.id === currentStageId;
        const interactive = stage.status !== 'idle';
        return (
          <button
            key={stage.id}
            type="button"
            onClick={() => interactive && onStageClick(stage.id)}
            disabled={!interactive}
            title={stage.hint}
            aria-current={active ? 'step' : undefined}
            className={`h-full w-full rounded-[13px] border px-4 py-4 text-left text-xs transition-all ${getStageStatusClasses(
              stage.status
            )} ${active ? 'ring-1 ring-[color:var(--signal)]' : ''} ${
              interactive ? 'cursor-pointer hover:border-[color:var(--muted)]' : 'cursor-default opacity-70'
            }`}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] opacity-60">0{idx + 1}</span>
              <span
                className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[stage.status]} ${
                  stage.status === 'running' ? 'animate-pulse motion-reduce:animate-none' : ''
                }`}
              />
            </div>
            <div className="text-[13px] font-medium">{stage.label}</div>
            {/* handoff 行恒 faint（即便运行态卡片整体着青）：它是静态产物标注，非「正在发生」 */}
            <div className="mt-1.5 font-mono text-[10.5px] tracking-[0.02em] text-[color:var(--faint)]">{HANDOFF[stage.id]}</div>
            {/* hint 保留：承载 IF-9 软门「为什么 / 解锁条件」 */}
            <div className="mt-1.5 text-[11px] leading-5 opacity-75">{stage.hint}</div>
          </button>
        );
      })}
      </div>
    </nav>
  );
}
