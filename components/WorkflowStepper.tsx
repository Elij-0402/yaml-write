'use client';

import { getStageStatusClasses, type WorkflowStage, type WorkflowSummary } from '../app/workflow';

const STATUS_DOT: Record<WorkflowStage['status'], string> = {
  done: 'bg-[color:var(--ink)]',
  running: 'bg-[color:var(--signal)]',
  ready: 'bg-[color:var(--faint)]',
  blocked: 'bg-[color:var(--danger)]',
  idle: 'bg-[color:var(--faint)]',
};

// 主线进度 Stepper：把 workflow.ts 里写好却从未被调用的 getNovelWorkflowSummary 变成顶部常驻导航，
// 用「阶段门」取代 page.tsx 三标志（workshopOpen/selectedNovelId/manageMode）的拼凑式切换。
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow !mb-1">Workflow · 主线流程</div>
          <p className="max-w-2xl text-xs leading-6 text-secondary">把导入、切分、DNA、创作收进同一条主线里。每个阶段既说明当前状态，也说明你为什么能点、为什么还不能点。</p>
        </div>
        <div className="hidden rounded-full border border-default bg-surface px-3 py-1 text-[11px] text-secondary md:block">
          下一步 · <span className="text-primary">{summary.recommendedNextStep}</span>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-4">
      {summary.stages.map((stage, idx) => {
        const active = stage.id === currentStageId;
        const interactive = stage.status !== 'idle';
        return (
          <div key={stage.id} className="relative">
            <button
              type="button"
              onClick={() => interactive && onStageClick(stage.id)}
              disabled={!interactive}
              title={stage.hint}
              aria-current={active ? 'step' : undefined}
              className={`h-full w-full rounded-[12px] border px-4 py-4 text-left text-xs transition-all ${getStageStatusClasses(
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
              <div className="mt-1 text-[11px] leading-5 opacity-75">{stage.hint}</div>
            </button>
            {idx < summary.stages.length - 1 && (
              <span className="pointer-events-none absolute -right-2 top-1/2 hidden -translate-y-1/2 text-muted lg:block">→</span>
            )}
          </div>
        );
      })}
      </div>
    </nav>
  );
}
