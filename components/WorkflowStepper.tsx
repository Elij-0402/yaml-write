'use client';

import { getStageStatusClasses, type WorkflowStage, type WorkflowSummary } from '../app/workflow';

const STATUS_ICON: Record<WorkflowStage['status'], string> = {
  done: '✓',
  running: '⏳',
  ready: '→',
  blocked: '⚠',
  idle: '·',
};

const STATUS_DOT: Record<WorkflowStage['status'], string> = {
  done: 'bg-[color:var(--ink)]',
  running: 'bg-[color:var(--signal)]',
  ready: 'bg-[color:var(--faint)]',
  blocked: 'bg-[color:var(--danger)]',
  idle: 'bg-[color:var(--faint)]',
};

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
    <nav aria-label="创作工程化主线">
      <div className="grid gap-2 auto-cols-fr lg:grid-cols-4 lg:gap-3">
        {summary.stages.map((stage, idx) => {
          const active = stage.id === currentStageId;
          const interactive = stage.status !== 'idle';
          const isComplete = stage.status === 'done';
          const isBlocked = stage.status === 'blocked';
          const isRunning = stage.status === 'running';
          
          return (
            <div key={stage.id} className="relative group">
              <button
                type="button"
                onClick={() => interactive && onStageClick(stage.id)}
                disabled={!interactive}
                title={stage.hint}
                aria-current={active ? 'step' : undefined}
                className={`w-full rounded-[10px] border px-3 py-3.5 text-left text-xs transition-all ${
                  active 
                    ? 'border-[color:var(--signal)]/50 bg-[color:var(--signal-soft)] ring-1 ring-[color:var(--signal)]/30' 
                    : isComplete 
                    ? 'border-default bg-[color:var(--surface)]' 
                    : isBlocked 
                    ? 'border-[color:var(--danger)]/30 bg-[color:var(--danger)]/5' 
                    : 'border-default bg-transparent'
                } ${
                  interactive ? 'cursor-pointer hover:border-[color:var(--muted)] hover:bg-[color:var(--surface)]' : 'cursor-default opacity-60'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted opacity-70">
                    Step {idx + 1}
                  </span>
                  <span
                    className={`shrink-0 text-[12px] ${
                      isComplete ? 'text-[color:var(--ink)]' : 
                      isRunning ? 'text-[color:var(--signal)] animate-pulse' : 
                      isBlocked ? 'text-[color:var(--danger)]' : 
                      'text-[color:var(--faint)]'
                    }`}
                  >
                    {STATUS_ICON[stage.status]}
                  </span>
                </div>
                <div className={`text-[12px] font-semibold leading-tight ${
                  active || isComplete ? 'text-primary' : 'text-secondary'
                }`}>
                  {stage.label}
                </div>
                <div className="mt-2 text-[10px] leading-4 text-muted opacity-80 line-clamp-2">
                  {stage.hint}
                </div>
              </button>
              {idx < summary.stages.length - 1 && (
                <div className="hidden lg:flex absolute -right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                  <span className={`text-muted opacity-30 text-sm`}>→</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
