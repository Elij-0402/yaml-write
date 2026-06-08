import { getLlmConfigError } from './llmClient';
import type { LLMConfig } from './store';

// 模型就绪判定——侧栏就绪点、DNA 板、工坊均消费。
// （旧的 getNovelWorkflowSummary / WorkflowStage 等阶段机制随 WorkflowStepper 一并退役、已删。）
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
