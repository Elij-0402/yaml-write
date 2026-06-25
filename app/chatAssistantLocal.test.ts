import { describe, it, expect } from 'vitest';
import {
  buildChatAssistantSystemPrompt,
  buildChatAssistantUserPrompt,
  type ChatAssistantLocalInput,
} from './chatAssistantLocal';

// 纯逻辑测试：前端「直连」对话助手的两个提示词构造器（镜像后端 api/prompts.py，须同步）。
// 注：异步的 chatAssistantLocal() 走真实 LLM 调用，按项目铁律不做自动化测试。

const baseInput = (patch: Partial<ChatAssistantLocalInput> = {}): ChatAssistantLocalInput => ({
  messages: [],
  entityCards: [],
  volumes: [],
  chapters: [],
  scenes: [],
  ...patch,
});

describe('buildChatAssistantSystemPrompt', () => {
  it('始终内联核心角色说明、关键规则与输出 JSON 模式提示', () => {
    const sys = buildChatAssistantSystemPrompt(baseInput());
    expect(sys).toContain('你是创作工坊的 AI 助手');
    expect(sys).toContain('【关键规则】');
    expect(sys).toContain('"entityCardUpdates"'); // RESPONSE_SCHEMA_HINT 注入
  });

  it('无卡片 / 无大纲时给出占位文案', () => {
    const sys = buildChatAssistantSystemPrompt(baseInput());
    expect(sys).toContain('（暂无设定卡片）');
    expect(sys).toContain('（暂无大纲）');
  });

  it('设定卡片按「[类型中文] id name——summary」渲染，类型映射为中文', () => {
    const sys = buildChatAssistantSystemPrompt(baseInput({
      entityCards: [
        { cardId: 'c1', type: 'character', name: '林鸣', summary: '废柴主角' },
        { cardId: 'c2', type: 'prop', name: '流光剑' }, // 无 summary
      ],
    }));
    expect(sys).toContain('- [人物] id=c1 name=林鸣——废柴主角');
    expect(sys).toContain('- [道具] id=c2 name=流光剑');
    // 无 summary 时不应拖出空的 —— 连接符
    expect(sys).not.toContain('name=流光剑——');
  });

  it('未知类型透传原值（不映射）', () => {
    const sys = buildChatAssistantSystemPrompt(baseInput({
      entityCards: [{ cardId: 'c9', type: 'faction', name: '黑风寨' }],
    }));
    expect(sys).toContain('- [faction] id=c9 name=黑风寨');
  });

  it('大纲按 卷→章→幕 三级缩进渲染，并按 order 排序', () => {
    const sys = buildChatAssistantSystemPrompt(baseInput({
      volumes: [
        { id: 'v2', title: '第二卷', order: 2 },
        { id: 'v1', title: '第一卷', order: 1 },
      ],
      chapters: [{ id: 'ch1', volumeId: 'v1', title: '开篇', order: 1 }],
      scenes: [{ id: 's1', chapterId: 'ch1', title: '相遇', order: 1 }],
    }));
    const outline = sys.slice(sys.indexOf('【当前已有大纲结构】'));
    // v1 在 v2 之前（按 order 升序）
    expect(outline.indexOf('id=v1')).toBeLessThan(outline.indexOf('id=v2'));
    expect(outline).toContain('卷 id=v1 title=第一卷');
    expect(outline).toContain('  章 id=ch1 title=开篇');
    expect(outline).toContain('    幕 id=s1 title=相遇');
  });

  it('归属卷不存在的章归入「章（无卷）」分支', () => {
    const sys = buildChatAssistantSystemPrompt(baseInput({
      volumes: [{ id: 'v1', title: '第一卷', order: 1 }],
      chapters: [{ id: 'orphan', volumeId: 'ghost', title: '散章', order: 1 }],
    }));
    expect(sys).toContain('  章（无卷）id=orphan title=散章');
  });
});

describe('buildChatAssistantUserPrompt', () => {
  it('无任何 user 消息时返回空串', () => {
    expect(buildChatAssistantUserPrompt([])).toBe('');
    expect(buildChatAssistantUserPrompt([{ role: 'assistant', content: '你好' }])).toBe('');
  });

  it('单条 user：仅输出「当前用户指令」，不含历史块', () => {
    const out = buildChatAssistantUserPrompt([{ role: 'user', content: '新建一张道具卡' }]);
    expect(out).toContain('【当前用户指令】\n新建一张道具卡');
    expect(out).not.toContain('【对话历史');
  });

  it('多轮对话：历史块（角色标签中文化）+ 末条 user 作为当前指令', () => {
    const out = buildChatAssistantUserPrompt([
      { role: 'user', content: '把林鸣改冷酷' },
      { role: 'assistant', content: '已更新' },
      { role: 'user', content: '再删除第二卷' },
    ]);
    expect(out).toContain('【对话历史');
    expect(out).toContain('用户：把林鸣改冷酷');
    expect(out).toContain('助手：已更新');
    expect(out).toContain('【当前用户指令】\n再删除第二卷');
  });

  it('以最后一条 user 为当前指令；其后的 assistant 既不入历史也非当前（被丢弃）', () => {
    const out = buildChatAssistantUserPrompt([
      { role: 'user', content: '指令甲' },
      { role: 'assistant', content: '尾随回复' },
    ]);
    expect(out).toBe('【当前用户指令】\n指令甲');
    expect(out).not.toContain('尾随回复');
  });

  it('过滤掉 system 等非 user/assistant 角色', () => {
    const out = buildChatAssistantUserPrompt([
      { role: 'system', content: '系统注入' },
      { role: 'user', content: '正经指令' },
    ]);
    expect(out).toBe('【当前用户指令】\n正经指令');
    expect(out).not.toContain('系统注入');
  });
});
