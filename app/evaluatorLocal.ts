import { callDirectStructured } from './llmClient';
import type { SceneEvaluateResponse } from './dnaSchema';

export const FORBIDDEN_STYLE_WORDS: string[] = [
  '不可否认', '嘴角上扬', '总而言之', '总之', '翻译腔', '命运的齿轮',
  '那一刻', '逆天改命', '眼神变得坚定', '嘴角勾起一抹弧度',
  '仿佛整个世界都安静了', '空气仿佛凝固', '心中一紧', '缓缓睁开眼', '不知为何',
];

export interface StyleLockResult {
  passed: boolean;
  reason: string;
}

export function runStyleLockHard(draft: string): StyleLockResult {
  const matched = FORBIDDEN_STYLE_WORDS.filter((w) => draft.includes(w));
  if (matched.length === 0) return { passed: true, reason: '' };
  return {
    passed: false,
    reason: `检测到违禁词/陈词滥调：${matched.join('、')}。`,
  };
}

interface ActiveCardInput {
  name: string;
  type: string;
  summary?: string;
  details?: string;
}

export interface LocalEvalInput {
  sceneId: string;
  attempt: number;
  draft: string;
  selectedDirection: {
    title?: string;
    worldviewBlock: string;
    protagonistBlock: string;
    antagonistBlock: string;
    narrativeTone: string;
  };
  currentScene: {
    sceneTitle: string;
    plotOutline: string;
    tensionLevel: string;
    visualCues: string;
  };
  activeCards: ActiveCardInput[];
}

export function buildEvaluatorSystemPrompt(): string {
  return (
    '你是一位极其严苛的小说草稿质检审计员（Evaluator Agent）。你的任务是针对生成的草稿进行深度逻辑审计与质量评估，执行"质检三把锁"校验，并输出结构化 JSON 评估报告。\n\n' +
    '【质检三把锁审计标准】\n' +
    '1. 风格锁（Style Lock）：\n' +
    '   - 审查 AI 腔调（如"不可否认"、"嘴角上扬"、"总之"、"总而言之"、"命运的齿轮"、"那一刻"、"眼神变得坚定"、"嘴角勾起一抹弧度"、"仿佛整个世界都安静了"等违禁词和陈词滥调）、翻译腔与废话。\n' +
    '   - 检验文本是否符合给定的文风色调与叙事基调（narrativeTone）。\n' +
    '2. 人设锁（Consistency Lock）：\n' +
    '   - 核对文本有无违背活跃/全局角色设定及世界常识（比对活跃设定卡片 activeCards 和创作方向设定 selectedDirection 中的主角/对手设定）。\n' +
    '   - 拦截逻辑违和与设定硬伤（例如：瞎子看四周/看表、聋子听琴、死人说话、没有修为的人飞天等）。\n' +
    '3. 大纲锁（Outline Lock）：\n' +
    '   - 检查文本是否包含且体现了当前场景大纲（currentScene.plotOutline）规定的剧情核心冲突、转折点与爽点/爆点。\n\n' +
    '【输出约束说明】\n' +
    '- 如果任意一把锁未通过（passed = false），必须在对应的 reason 中指明具体原因与原文违规证据，并在最终的 actionableFeedback 中给出具体、可执行、无废话的重写改进指令。\n' +
    '- 如果该锁通过（passed = true），则 reason 填空字符串 ""；如果三把锁全部通过，则 actionableFeedback 也必须为 ""。\n' +
    '- 必须以严格的结构化 JSON 格式输出，符合以下模式：\n' +
    '{\n' +
    '  "styleLock": { "passed": boolean, "reason": string },\n' +
    '  "consistencyLock": { "passed": boolean, "reason": string },\n' +
    '  "outlineLock": { "passed": boolean, "reason": string },\n' +
    '  "actionableFeedback": string\n' +
    '}'
  );
}

export function buildEvaluatorUserPrompt(params: LocalEvalInput): string {
  const d = params.selectedDirection;
  const scene = params.currentScene;

  const TYPE_MAP: Record<string, string> = {
    worldview: '世界规章',
    character: '人物',
    prop: '道具',
    geography: '地理',
  };

  let activeCardsBlock = '（无活跃设定卡片）';
  if (params.activeCards.length > 0) {
    const lines: string[] = [];
    for (const card of params.activeCards) {
      if (!card.name || !card.name.trim()) continue;
      const typeZh = TYPE_MAP[card.type] || card.type;
      const summaryPart = card.summary?.trim() ? `：${card.summary.trim()}` : '';
      let cardStr = `- 【${typeZh}】${card.name}${summaryPart}`;
      if (card.details?.trim()) {
        const detailsIndented = card.details.trim().split('\n').join('\n  ');
        cardStr += `\n  详细设定：${detailsIndented}`;
      }
      lines.push(cardStr);
    }
    if (lines.length > 0) activeCardsBlock = lines.join('\n');
  }

  return (
    `【评估输入上下文】\n` +
    `1. 场景 ID (sceneId): ${params.sceneId}\n` +
    `2. 尝试轮次 (attempt): ${params.attempt}\n\n` +
    `【融合方向设定 (selectedDirection)】\n` +
    `- 世界观: ${d.worldviewBlock}\n` +
    `- 主角设定: ${d.protagonistBlock}\n` +
    `- 对手设定: ${d.antagonistBlock}\n` +
    `- 叙事风格/色调 (narrativeTone): ${d.narrativeTone}\n\n` +
    `【当前场景大纲 (currentScene)】\n` +
    `- 标题: ${scene.sceneTitle}\n` +
    `- 情节走向与核心冲突 (plotOutline): ${scene.plotOutline}\n` +
    `- 张力曲线: ${scene.tensionLevel}\n` +
    `- 画面意象: ${scene.visualCues}\n\n` +
    `【活跃设定卡片 (activeCards)】\n` +
    `${activeCardsBlock}\n\n` +
    `==================================================\n` +
    `【待审计的小说草稿正文 (draft)】\n` +
    `${params.draft}\n` +
    `==================================================\n\n` +
    `请针对上述待审计的小说草稿正文执行"质检三把锁"审计，并输出结构化评估结果。`
  );
}

interface GateResultLocal {
  passed: boolean;
  reason: string;
}

interface SceneAuditResult {
  styleLock: GateResultLocal;
  consistencyLock: GateResultLocal;
  outlineLock: GateResultLocal;
  actionableFeedback: string;
}

export function parseSceneAuditResult(json: unknown): SceneAuditResult {
  if (!json || typeof json !== 'object') throw new Error('评估结果格式异常：非对象。');
  const obj = json as Record<string, unknown>;

  function parseGate(name: string): GateResultLocal {
    const gate = obj[name];
    if (!gate || typeof gate !== 'object') return { passed: true, reason: '' };
    const g = gate as Record<string, unknown>;
    return {
      passed: typeof g.passed === 'boolean' ? g.passed : true,
      reason: typeof g.reason === 'string' ? g.reason : '',
    };
  }

  return {
    styleLock: parseGate('styleLock'),
    consistencyLock: parseGate('consistencyLock'),
    outlineLock: parseGate('outlineLock'),
    actionableFeedback: typeof obj.actionableFeedback === 'string' ? obj.actionableFeedback : '',
  };
}

export async function evaluateSceneLocal(
  params: LocalEvalInput,
  opts?: { signal?: AbortSignal }
): Promise<SceneEvaluateResponse> {
  // 1. 硬编码违禁词扫描
  const hardResult = runStyleLockHard(params.draft);

  // 2. LLM 结构化审计
  const systemPrompt = buildEvaluatorSystemPrompt();
  const userPrompt = buildEvaluatorUserPrompt(params);

  const llmAudit = await callDirectStructured<SceneAuditResult>(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { signal: opts?.signal, parse: parseSceneAuditResult }
  );

  // 3. 双轨合并（镜像后端逻辑）
  const stylePassed = hardResult.passed && llmAudit.styleLock.passed;
  const styleReasons: string[] = [];
  if (!hardResult.passed) styleReasons.push(hardResult.reason);
  if (!llmAudit.styleLock.passed && llmAudit.styleLock.reason) {
    styleReasons.push(llmAudit.styleLock.reason);
  }
  const styleReason = styleReasons.join(' ');

  const consistencyPassed = llmAudit.consistencyLock.passed;
  const consistencyReason = llmAudit.consistencyLock.reason || '';

  const outlinePassed = llmAudit.outlineLock.passed;
  const outlineReason = llmAudit.outlineLock.reason || '';

  const passed = stylePassed && consistencyPassed && outlinePassed;

  const failedGates: string[] = [];
  if (!stylePassed) failedGates.push('StyleLock');
  if (!consistencyPassed) failedGates.push('ConsistencyLock');
  if (!outlinePassed) failedGates.push('OutlineLock');

  let evidence = '';
  let actionableFeedback = '';

  if (!passed) {
    const evidenceParts: string[] = [];
    if (!stylePassed) evidenceParts.push(`【风格锁未通过】${styleReason}`);
    if (!consistencyPassed) evidenceParts.push(`【人设锁未通过】${consistencyReason}`);
    if (!outlinePassed) evidenceParts.push(`【大纲锁未通过】${outlineReason}`);
    evidence = evidenceParts.join('\n');

    const feedbackParts: string[] = [];
    if (!hardResult.passed) {
      const matched = FORBIDDEN_STYLE_WORDS.filter((w) => params.draft.includes(w));
      feedbackParts.push(`请删除或替换以下违禁词与 AI 腔：${matched.join('、')}。`);
    }
    if (llmAudit.actionableFeedback) feedbackParts.push(llmAudit.actionableFeedback);
    actionableFeedback = feedbackParts.join('\n');
  }

  return {
    sceneId: params.sceneId,
    attempt: params.attempt,
    passed,
    failedGates,
    evidence,
    actionableFeedback,
  };
}

// === 成稿正文 prompt 构造（镜像后端 build_scene_system_prompt / build_scene_user_prompt）===

const ANTI_SLOP_CONSTRAINT =
  '【反 AI 套路硬约束】严禁出现陈词滥调与空洞煽情，包括但不限于：' +
  '"命运的齿轮""那一刻""逆天改命""眼神变得坚定""嘴角勾起一抹弧度""仿佛整个世界都安静了"' +
  '"空气仿佛凝固""心中一紧""缓缓睁开眼""不知为何"等。' +
  '禁止宏大空泛的抒情与解释性旁白；改用冰冷、具象、高信息密度的物理细节与克制白描，' +
  '让冲突通过动作、环境与器物呈现，而非作者直接告知。文字要有颗粒度与刺痛感。';

const TONE_GUIDE: Record<string, string> = {
  cold: '本篇文风寄存器：冷峻克制——物理细节、克制白描、零煽情。',
  hot: '本篇文风寄存器：热血爽快——节奏明快、爽点张扬、情绪有冲击力；但仍避免空喊口号与陈词滥调。',
  humor: '本篇文风寄存器：幽默轻快——机锋、反差与节奏感；但不滑向油滑段子或网络梗堆砌。',
  lyrical: '本篇文风寄存器：抒情细腻——意象与情绪自然流动；但避免空泛宏大的抒情套话与无信息量的辞藻。',
};

const NON_COLD_TONE_RELEASE =
  '（注意：本篇请贴合上述文风寄存器，不要强行压成统一的冷峻法医腔；' +
  '上面的反套路约束仍然有效——禁陈词滥调与空洞煽情，但允许该寄存器应有的温度与色彩。）';

function buildToneClause(tone?: string): string {
  const key = (tone || '').trim();
  if (!key) return '';
  let clause = '\n' + (TONE_GUIDE[key] || `本篇文风寄存器：${key}。`);
  if (key !== 'cold') clause += '\n' + NON_COLD_TONE_RELEASE;
  return clause;
}

const MAX_SCENE_CONTEXT_CHARS = 24000;

function trimTextTail(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(-maxChars);
}

export interface GenerateSceneInput {
  selectedDirection: {
    title?: string;
    worldviewBlock: string;
    protagonistBlock: string;
    antagonistBlock: string;
    narrativeTone: string;
  };
  currentScene: {
    sceneNumber?: number;
    sceneTitle: string;
    plotOutline: string;
    tensionLevel: string;
    visualCues: string;
  };
  precedingTexts?: Record<number | string, string>;
  currentDraft?: string;
  activeCards?: ActiveCardInput[];
  adversarialRules?: string;
  tone?: string;
}

export function buildGenerateSceneSystemPrompt(input: GenerateSceneInput): string {
  let adv = ANTI_SLOP_CONSTRAINT;
  if (input.adversarialRules?.trim()) {
    adv += `\n【用户红队对抗规则（必须遵守）】：${input.adversarialRules.trim()}`;
  }
  return (
    '你是一位文字极具颗粒度的小说家。请根据给定的设定积木与当前分镜大纲创作小说正文。\n' +
    adv +
    buildToneClause(input.tone) +
    '\n直接输出正文，不要任何前言、标题或解释。'
  );
}

export function buildGenerateSceneUserPrompt(input: GenerateSceneInput): string {
  const d = input.selectedDirection;
  const scene = input.currentScene;

  const entries = Object.entries(input.precedingTexts || {}).sort(
    ([a], [b]) => Number(a) - Number(b)
  );
  let preceding = entries
    .filter(([, text]) => text?.trim())
    .map(([, text]) => text)
    .join('\n\n');
  preceding = trimTextTail(preceding, MAX_SCENE_CONTEXT_CHARS);
  const precedingBlock = preceding.trim() || '（这是开篇第一个分镜，无前文。）';

  const currentDraft = trimTextTail(input.currentDraft || '', MAX_SCENE_CONTEXT_CHARS);
  let resumeBlock = '';
  let resumeInstruction = '请紧密承接前置分镜最后一句话的语气、环境与角色站位，继续创作当前分镜。';
  if (currentDraft) {
    resumeBlock =
      `\n【当前分镜已生成正文（不要重复）】\n` +
      `----- 当前分镜草稿（续写基线） -----\n${currentDraft}\n-------------------\n`;
    resumeInstruction =
      '请严格从"当前分镜草稿"的最后一句继续接写，延续语气、角色站位与环境细节。' +
      '严禁复述草稿中已出现的句段。';
  }

  const TYPE_MAP: Record<string, string> = {
    worldview: '世界规章',
    character: '人物',
    prop: '道具',
    geography: '地理',
  };

  let activeCardsBlock = '';
  if (input.activeCards?.length) {
    const sceneActive: string[] = [];
    const globalActive: string[] = [];
    for (const card of input.activeCards) {
      if (!card.name?.trim()) continue;
      const typeZh = TYPE_MAP[card.type] || card.type;
      const summaryPart = card.summary?.trim() ? `：${card.summary.trim()}` : '';
      let cardStr = `- 【${typeZh}】${card.name}${summaryPart}`;
      if (card.details?.trim()) {
        const detailsIndented = card.details.trim().split('\n').join('\n  ');
        cardStr += `\n  详细设定：${detailsIndented}`;
      }
      if ((card as { activeState?: string }).activeState === 'sceneActive') {
        sceneActive.push(cardStr);
      } else {
        globalActive.push(cardStr);
      }
    }
    if (sceneActive.length || globalActive.length) {
      activeCardsBlock = '【活跃设定上下文】\n';
      if (sceneActive.length) activeCardsBlock += '当前场景活跃设定：\n' + sceneActive.join('\n') + '\n';
      if (globalActive.length) activeCardsBlock += '全局活跃设定：\n' + globalActive.join('\n') + '\n';
      activeCardsBlock += '\n';
    }
  }

  return (
    `【角色设定与世界观积木】\n世界观：${d.worldviewBlock}\n主角：${d.protagonistBlock}\n` +
    `对手：${d.antagonistBlock}\n叙事色调：${d.narrativeTone}\n\n` +
    activeCardsBlock +
    `【当前要写作的分镜】\n标题：${scene.sceneTitle}\n情节走向：${scene.plotOutline}\n` +
    `张力：${scene.tensionLevel}\n画面意象：${scene.visualCues}\n\n` +
    `【前置分镜已写出的实际正文（供承上启下）】\n----- 前情回顾 -----\n${precedingBlock}\n-------------------\n` +
    resumeBlock +
    resumeInstruction +
    '严禁剧情断层或设定漂移。直接开始输出正文，不要重复前文。'
  );
}
