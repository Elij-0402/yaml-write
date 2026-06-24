import { callDirectStructured } from './llmClient';
import { parseChatAssistantResponse, type ChatAssistantResponse } from './dnaSchema';

// 前端「直连大模型」版对话助手（review #6）：clientDirectMode 或后端不可达时，AiAssistant 走这里而非
// /api/py/chat-assistant，否则纯静态托管（GitHub Pages 等）下整个对话助手不可用。
// 提示词镜像后端 api/prompts.py 的 build_chat_assistant_system_prompt / build_chat_assistant_user_prompt
// （两侧改动需同步，范式同 evaluatorLocal 镜像后端 evaluator）。直连用 response_format=json_object（无 instructor
// 工具调用），故系统提示额外内联 ChatAssistantResponse 的 JSON 模式，帮助模型产出合规结构。

interface CardCtx { cardId: string; type: string; name: string; summary?: string }
interface VolumeCtx { id: string; title: string; order: number }
interface ChapterCtx { id: string; volumeId: string; title: string; order: number }
interface SceneCtx { id: string; chapterId: string; title: string; order: number }

export interface ChatAssistantLocalInput {
  messages: { role: string; content: string }[];
  entityCards: CardCtx[];
  volumes: VolumeCtx[];
  chapters: ChapterCtx[];
  scenes: SceneCtx[];
}

const TYPE_MAP: Record<string, string> = { worldview: '世界规章', character: '人物', prop: '道具', geography: '地理' };

function formatEntityCardsContext(cards: CardCtx[]): string {
  if (!cards.length) return '（暂无设定卡片）';
  return cards
    .map((c) => {
      const typeZh = TYPE_MAP[c.type] || c.type;
      const summaryPart = c.summary ? `——${c.summary}` : '';
      return `- [${typeZh}] id=${c.cardId} name=${c.name}${summaryPart}`;
    })
    .join('\n');
}

function formatOutlineContext(volumes: VolumeCtx[], chapters: ChapterCtx[], scenes: SceneCtx[]): string {
  if (!volumes.length && !chapters.length && !scenes.length) return '（暂无大纲）';
  const lines: string[] = [];
  for (const vol of [...volumes].sort((a, b) => a.order - b.order)) {
    lines.push(`卷 id=${vol.id} title=${vol.title}`);
    const volChapters = chapters.filter((ch) => ch.volumeId === vol.id).sort((a, b) => a.order - b.order);
    for (const ch of volChapters) {
      lines.push(`  章 id=${ch.id} title=${ch.title}`);
      const chScenes = scenes.filter((s) => s.chapterId === ch.id).sort((a, b) => a.order - b.order);
      for (const sc of chScenes) lines.push(`    幕 id=${sc.id} title=${sc.title}`);
    }
  }
  const orphan = chapters.filter((ch) => !volumes.some((v) => v.id === ch.volumeId)).sort((a, b) => a.order - b.order);
  for (const ch of orphan) lines.push(`  章（无卷）id=${ch.id} title=${ch.title}`);
  return lines.length ? lines.join('\n') : '（暂无大纲）';
}

const RESPONSE_SCHEMA_HINT =
  '【输出 JSON 模式（必须严格遵守，无操作时对应 updates 用空数组 []）】\n' +
  '{\n' +
  '  "reply": string,\n' +
  '  "entityCardUpdates": [{ "action": "upsert"|"delete", "cardId": string, "type": "worldview"|"character"|"prop"|"geography", "name": string, "summary": string, "details": string }],\n' +
  '  "volumeUpdates": [{ "action": "upsert"|"delete", "volume": { "id": string, "title": string, "order": number } }],\n' +
  '  "chapterUpdates": [{ "action": "upsert"|"delete", "chapter": { "id": string, "volumeId": string, "title": string, "order": number } }],\n' +
  '  "sceneUpdates": [{ "action": "upsert"|"delete", "scene": { "id": string, "chapterId": string, "title": string, "synopsis": string, "order": number } }]\n' +
  '}';

export function buildChatAssistantSystemPrompt(input: ChatAssistantLocalInput): string {
  const cardsCtx = formatEntityCardsContext(input.entityCards);
  const outlineCtx = formatOutlineContext(input.volumes, input.chapters, input.scenes);
  return (
    '你是创作工坊的 AI 助手。用户会在对话中指挥你修改设定卡片或大纲（卷/章/幕）。\n' +
    '你的任务：\n' +
    '1. 理解用户自然语言意图（如"把林鸣的性格改为冷酷"、"新建一个叫流光剑的道具卡"、"删除第二卷"）。\n' +
    '2. 在 reply 字段用简洁中文回应用户。\n' +
    '3. 在对应的 updates 字段中输出精确的结构化操作。\n\n' +
    '【关键规则】\n' +
    '- 修改已有卡片时，必须使用其已有的 cardId，严禁分配新 ID 导致冗余。\n' +
    '- 修改已有大纲节点时，必须使用其已有的 id。\n' +
    '- 新建实体时 cardId/id 留空字符串，由前端生成。\n' +
    '- 删除操作需填写 action="delete" 并提供对应 id。\n' +
    '- 如果用户指令与设定/大纲修改无关（如闲聊、问答），仅在 reply 回答即可，updates 留空数组。\n' +
    '- upsert 操作时，name 字段必须填写。\n\n' +
    `【当前已有设定卡片】\n${cardsCtx}\n\n` +
    `【当前已有大纲结构】\n${outlineCtx}\n\n` +
    RESPONSE_SCHEMA_HINT
  );
}

// 把多轮对话拼成转写：历史轮供上下文/指代，末条 user 为当前指令（镜像后端 build_chat_assistant_user_prompt）。
export function buildChatAssistantUserPrompt(messages: { role: string; content: string }[]): string {
  const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  let lastUserIdx = -1;
  for (let i = convo.length - 1; i >= 0; i--) {
    if (convo[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return '';
  const current = convo[lastUserIdx].content;
  const history = convo.slice(0, lastUserIdx);
  const roleLabel: Record<string, string> = { user: '用户', assistant: '助手' };
  const parts: string[] = [];
  if (history.length) {
    const histBlock = history.map((m) => `${roleLabel[m.role] || m.role}：${m.content}`).join('\n');
    parts.push('【对话历史（供理解上下文与指代，请勿重复执行历史里已完成的指令）】\n' + histBlock + '\n');
  }
  parts.push('【当前用户指令】\n' + current);
  return parts.join('\n');
}

export async function chatAssistantLocal(
  input: ChatAssistantLocalInput,
  opts?: { signal?: AbortSignal },
): Promise<ChatAssistantResponse> {
  const system = buildChatAssistantSystemPrompt(input);
  const user = buildChatAssistantUserPrompt(input.messages);
  return callDirectStructured<ChatAssistantResponse>(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { signal: opts?.signal, parse: parseChatAssistantResponse },
  );
}
