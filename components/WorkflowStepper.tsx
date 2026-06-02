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
    <nav className="flex items-center gap-1.5 overflow-x-auto" aria-label="创作主线进度">
      {summary.stages.map((stage, idx) => {
        const active = stage.id === currentStageId;
        const interactive = stage.status !== 'idle';
        return (
          <div key={stage.id} className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => interactive && onStageClick(stage.id)}
              disabled={!interactive}
              title={stage.hint}
              aria-current={active ? 'step' : undefined}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-all ${getStageStatusClasses(
                stage.status
              )} ${active ? 'ring-1 ring-white/25' : ''} ${
                interactive ? 'cursor-pointer hover:brightness-125' : 'cursor-default opacity-60'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[stage.status]} ${
                  stage.status === 'running' ? 'animate-pulse motion-reduce:animate-none' : ''
                }`}
              />
              <span className="font-mono text-[10px] opacity-60">{idx + 1}</span>
              <span className="font-medium">{stage.shortLabel}</span>
            </button>
            {idx < summary.stages.length - 1 && <span className="select-none text-zinc-700">→</span>}
          </div>
        );
      })}
      <span className="ml-2 hidden truncate text-[11px] text-zinc-500 md:inline">
        下一步 · {summary.recommendedNextStep}
      </span>
    </nav>
  );
}
