import { type Novel } from './db';
import { getLlmConfigError } from './llmClient';
import type { LLMConfig } from './store';

export type StageStatus = 'idle' | 'ready' | 'blocked' | 'running' | 'done';

export interface WorkflowStage {
  id: 'import' | 'split' | 'dna' | 'fusion';
  label: string;
  shortLabel: string;
  status: StageStatus;
  hint: string;
}

export interface WorkflowSummary {
  stages: WorkflowStage[];
  recommendedNextStep: string;
  readinessReason?: string;
}

export function getLlmReadinessSummary(config?: LLMConfig): {
  ok: boolean;
  reason?: string;
} {
  const error = getLlmConfigError(config);
  if (error) {
    return { ok: false, reason: error };
  }
  return { ok: true };
}

export function getNovelWorkflowSummary(
  novel: Novel | null,
  config: LLMConfig,
  readyNovelCount: number
): WorkflowSummary {
  const llm = getLlmReadinessSummary(config);

  if (!novel) {
    return {
      stages: [
        {
          id: 'import',
          label: '导入文本',
          shortLabel: '导入',
          status: 'ready',
          hint: '导入一本小说，工坊才会开始生成项目轨迹。',
        },
        {
          id: 'split',
          label: '校验切分',
          shortLabel: '切分',
          status: 'idle',
          hint: '导入后可检查章节切分质量与异常噪音。',
        },
        {
          id: 'dna',
          label: '提取 DNA',
          shortLabel: 'DNA',
          status: llm.ok ? 'idle' : 'blocked',
          hint: llm.ok ? '完成切分后即可提取题材、角色与结构摘要。' : llm.reason || '请先配置模型。',
        },
        {
          id: 'fusion',
          label: '融合变体',
          shortLabel: '变体',
          status: readyNovelCount > 1 ? 'ready' : 'blocked',
          hint:
            readyNovelCount > 1
              ? '已有至少两部 DNA 就绪作品，可生成方向卡、故事板与正文变体草案。'
              : '至少需要两部 DNA 就绪作品，变体阶段才有足够的碰撞素材。',
        },
      ],
      recommendedNextStep: '导入第一部作品',
      readinessReason: llm.reason || (readyNovelCount > 1 ? undefined : '至少需要两部 DNA 就绪作品，变体阶段才会点亮。'),
    };
  }

  const importDone: WorkflowStage = {
    id: 'import',
    label: '导入文本',
    shortLabel: '导入',
    status: 'done',
    hint: `${novel.wordCount.toLocaleString()} 字原文已入库，可继续校验切分。`,
  };

  const splitStage: WorkflowStage = {
    id: 'split',
    label: '校验切分',
    shortLabel: '切分',
    status: novel.splitStatus === 'needs_review' ? 'blocked' : 'done',
    hint:
      novel.splitStatus === 'needs_review'
        ? '切分结果存在异常，建议先在切分校验台中修复后再提取。'
        : '章节切分结果可直接进入 DNA 提取。',
  };

  let dnaStage: WorkflowStage;
  if (!llm.ok) {
    dnaStage = {
      id: 'dna',
      label: '提取 DNA',
      shortLabel: 'DNA',
      status: 'blocked',
      hint: llm.reason || '请先配置模型。',
    };
  } else if (novel.analysisStatus === 'mapping' || novel.analysisStatus === 'reducing') {
    dnaStage = {
      id: 'dna',
      label: '提取 DNA',
      shortLabel: 'DNA',
      status: 'running',
      hint: '正在抽取题材、角色、结构与风格摘要。',
    };
  } else if (novel.analysisStatus === 'done' && novel.dnaCard) {
    dnaStage = {
      id: 'dna',
      label: '提取 DNA',
      shortLabel: 'DNA',
      status: 'done',
      hint: 'DNA 创作骨架已就绪，可作为后续变体生成的输入资产。',
    };
  } else if (novel.splitStatus === 'needs_review') {
    dnaStage = {
      id: 'dna',
      label: '提取 DNA',
      shortLabel: 'DNA',
      status: 'blocked',
      hint: '建议先修复切分质量，再开始 DNA 提取。',
    };
  } else {
    dnaStage = {
      id: 'dna',
      label: '提取 DNA',
      shortLabel: 'DNA',
      status: 'ready',
      hint: '模型已就绪，可以开始快速预览或完整提取。',
    };
  }

  const fusionStage: WorkflowStage =
    novel.analysisStatus === 'done' && novel.dnaCard
      ? {
          id: 'fusion',
          label: '融合变体',
          shortLabel: '变体',
          status: readyNovelCount > 1 ? 'ready' : 'blocked',
          hint:
            readyNovelCount > 1
              ? '至少已有两部 DNA 就绪作品，可生成方向卡、故事板与正文变体草案。'
              : 'DNA 资产不足。再完成一部作品的 DNA，变体阶段才会真正成立。',
        }
      : {
          id: 'fusion',
          label: '融合变体',
          shortLabel: '变体',
          status: 'idle',
          hint: '先完成这部作品的 DNA 提取，再进入变体生成阶段。',
        };

  const recommendedNextStep =
    splitStage.status === 'blocked'
      ? '先修复切分质量'
      : dnaStage.status === 'blocked'
      ? '先完成模型配置'
      : dnaStage.status === 'ready'
      ? '开始 DNA 提取'
      : dnaStage.status === 'running'
      ? '等待 DNA 提取完成'
      : fusionStage.status === 'ready'
      ? '前往变体生成'
      : '再完成一部作品的 DNA';

  return {
    stages: [importDone, splitStage, dnaStage, fusionStage],
    recommendedNextStep,
    readinessReason: llm.reason,
  };
}

export function getStageStatusClasses(status: StageStatus): string {
  switch (status) {
    case 'done':
      return 'border-emerald-500/20 bg-emerald-500/[0.04] text-emerald-400';
    case 'running':
      return 'border-amber-500/20 bg-amber-500/[0.04] text-amber-400';
    case 'ready':
      return 'border-blue-500/20 bg-blue-500/[0.04] text-blue-400';
    case 'blocked':
      return 'border-rose-500/20 bg-rose-500/[0.04] text-rose-400';
    default:
      return 'border-hairline bg-white/[0.01] text-zinc-500';
  }
}
