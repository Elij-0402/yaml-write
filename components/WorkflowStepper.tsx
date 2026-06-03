'use client';

import { getStageStatusClasses, type WorkflowStage, type WorkflowSummary } from '../app/workflow';

const STATUS_DOT: Record<WorkflowStage['status'], string> = {
  done: 'bg-emerald-400',
  running: 'bg-amber-400',
  ready: 'bg-blue-400',
  blocked: 'bg-rose-400',
  idle: 'bg-zinc-600',
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
    <nav className="space-y-3" aria-label="创作主线进度">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="eyebrow !mb-1">Workflow · 主线流程</div>
          <p className="text-xs text-secondary">所有状态都围绕同一条制作链路展开，不再在不同面板里跳语境。</p>
        </div>
        <div className="hidden rounded-full border border-default bg-secondary px-3 py-1 text-[11px] text-secondary md:block">
          下一步 · <span className="text-primary">{summary.recommendedNextStep}</span>
        </div>
      </div>
      <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
      {summary.stages.map((stage, idx) => {
        const active = stage.id === currentStageId;
        const interactive = stage.status !== 'idle';
        return (
          <div key={stage.id} className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => interactive && onStageClick(stage.id)}
              disabled={!interactive}
              title={stage.hint}
              aria-current={active ? 'step' : undefined}
              className={`min-w-[148px] rounded-xl border px-3 py-3 text-left text-xs transition-all ${getStageStatusClasses(
                stage.status
              )} ${active ? 'ring-1 ring-white/20 shadow-[0_10px_30px_rgba(0,0,0,0.18)]' : ''} ${
                interactive ? 'cursor-pointer hover:-translate-y-0.5 hover:brightness-110' : 'cursor-default opacity-60'
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] opacity-60">0{idx + 1}</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[stage.status]} ${
                    stage.status === 'running' ? 'animate-pulse motion-reduce:animate-none' : ''
                  }`}
                />
              </div>
              <div className="font-medium">{stage.label}</div>
              <div className="mt-1 text-[11px] opacity-75">{stage.hint}</div>
            </button>
            {idx < summary.stages.length - 1 && <span className="select-none text-muted">→</span>}
          </div>
        );
      })}
      </div>
    </nav>
  );
}
