import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_STYLE_WORDS,
  runStyleLockHard,
  buildEvaluatorUserPrompt,
  parseSceneAuditResult,
  type LocalEvalInput,
} from './evaluatorLocal';

describe('evaluatorLocal', () => {
  describe('FORBIDDEN_STYLE_WORDS', () => {
    it('matches api/prompts.py FORBIDDEN_STYLE_WORDS byte-for-byte (sync guard — keep both in lockstep)', () => {
      // 此列表必须与 api/prompts.py 的 FORBIDDEN_STYLE_WORDS 完全一致；任一侧改动都应同步另一侧与本断言。
      expect(FORBIDDEN_STYLE_WORDS).toEqual([
        '不可否认', '嘴角上扬', '总而言之', '总之', '翻译腔', '命运的齿轮',
        '那一刻', '逆天改命', '眼神变得坚定', '嘴角勾起一抹弧度',
        '仿佛整个世界都安静了', '空气仿佛凝固', '心中一紧', '缓缓睁开眼', '不知为何',
      ]);
    });
  });

  describe('runStyleLockHard', () => {
    it('returns passed=true when no forbidden words are present', () => {
      const result = runStyleLockHard('主角凝视远方，握紧了手中的剑。');
      expect(result.passed).toBe(true);
      expect(result.reason).toBe('');
    });

    it('returns passed=false with matched words listed', () => {
      const result = runStyleLockHard('这一刻，主角嘴角上扬，不可否认他很强。');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('嘴角上扬');
      expect(result.reason).toContain('不可否认');
    });

    it('detects a single forbidden word', () => {
      const result = runStyleLockHard('命运的齿轮已经开始转动。');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('命运的齿轮');
    });

    it('handles empty draft', () => {
      const result = runStyleLockHard('');
      expect(result.passed).toBe(true);
    });
  });

  describe('buildEvaluatorUserPrompt', () => {
    const baseInput: LocalEvalInput = {
      sceneId: 'scene_001',
      attempt: 1,
      draft: '一段草稿正文。',
      selectedDirection: {
        worldviewBlock: '科幻世界',
        protagonistBlock: '萧炎',
        antagonistBlock: '魂天帝',
        narrativeTone: '冷峻法医腔',
      },
      currentScene: {
        sceneTitle: '开端',
        plotOutline: '主角在实验室里炼丹。',
        tensionLevel: 'mid',
        visualCues: '深蓝色色调',
      },
      activeCards: [],
    };

    it('produces output containing all direction fields', () => {
      const prompt = buildEvaluatorUserPrompt(baseInput);
      expect(prompt).toContain('科幻世界');
      expect(prompt).toContain('萧炎');
      expect(prompt).toContain('魂天帝');
      expect(prompt).toContain('冷峻法医腔');
    });

    it('produces output containing scene fields', () => {
      const prompt = buildEvaluatorUserPrompt(baseInput);
      expect(prompt).toContain('开端');
      expect(prompt).toContain('主角在实验室里炼丹');
      expect(prompt).toContain('mid');
    });

    it('shows placeholder when activeCards is empty', () => {
      const prompt = buildEvaluatorUserPrompt(baseInput);
      expect(prompt).toContain('（无活跃设定卡片）');
    });

    it('renders active cards when provided', () => {
      const input: LocalEvalInput = {
        ...baseInput,
        activeCards: [
          { name: '冷凝仪', type: 'prop', summary: '科研道具', details: '能凝结灵气的仪器' },
        ],
      };
      const prompt = buildEvaluatorUserPrompt(input);
      expect(prompt).toContain('【道具】冷凝仪');
      expect(prompt).toContain('科研道具');
      expect(prompt).toContain('能凝结灵气的仪器');
      expect(prompt).not.toContain('（无活跃设定卡片）');
    });

    it('skips cards with empty names', () => {
      const input: LocalEvalInput = {
        ...baseInput,
        activeCards: [
          { name: '', type: 'character', summary: 'nobody' },
          { name: '有效角色', type: 'character', summary: '主要人物' },
        ],
      };
      const prompt = buildEvaluatorUserPrompt(input);
      expect(prompt).not.toContain('nobody');
      expect(prompt).toContain('有效角色');
    });

    it('includes sceneId and attempt', () => {
      const prompt = buildEvaluatorUserPrompt(baseInput);
      expect(prompt).toContain('scene_001');
      expect(prompt).toContain('1');
    });
  });

  describe('parseSceneAuditResult', () => {
    it('parses a valid full result', () => {
      const raw = {
        styleLock: { passed: true, reason: '' },
        consistencyLock: { passed: false, reason: '角色设定矛盾' },
        outlineLock: { passed: true, reason: '' },
        actionableFeedback: '修复人设冲突',
      };
      const result = parseSceneAuditResult(raw);
      expect(result.styleLock.passed).toBe(true);
      expect(result.consistencyLock.passed).toBe(false);
      expect(result.consistencyLock.reason).toBe('角色设定矛盾');
      expect(result.actionableFeedback).toBe('修复人设冲突');
    });

    it('throws on a missing gate (strict — mirrors backend Pydantic, no silent pass)', () => {
      expect(() => parseSceneAuditResult({ actionableFeedback: '' })).toThrow();
      expect(() => parseSceneAuditResult({
        styleLock: { passed: true, reason: '' },
        consistencyLock: { passed: true, reason: '' },
        actionableFeedback: '',
      })).toThrow();
    });

    it('throws when a gate passed is not a boolean', () => {
      expect(() => parseSceneAuditResult({
        styleLock: { passed: 'yes', reason: '' },
        consistencyLock: { passed: true, reason: '' },
        outlineLock: { passed: true, reason: '' },
        actionableFeedback: '',
      })).toThrow();
    });

    it('throws on non-object input', () => {
      expect(() => parseSceneAuditResult(null)).toThrow();
      expect(() => parseSceneAuditResult('string')).toThrow();
    });
  });

  describe('merge logic integration', () => {
    it('hard fail + LLM pass → overall style fails', () => {
      const hardResult = runStyleLockHard('嘴角上扬着走了过来。');
      expect(hardResult.passed).toBe(false);

      const llmAudit = parseSceneAuditResult({
        styleLock: { passed: true, reason: '' },
        consistencyLock: { passed: true, reason: '' },
        outlineLock: { passed: true, reason: '' },
        actionableFeedback: '',
      });

      const stylePassed = hardResult.passed && llmAudit.styleLock.passed;
      expect(stylePassed).toBe(false);
    });

    it('hard pass + LLM fail → overall style fails', () => {
      const hardResult = runStyleLockHard('干净的正文没有违禁词。');
      expect(hardResult.passed).toBe(true);

      const llmAudit = parseSceneAuditResult({
        styleLock: { passed: false, reason: '文笔偏翻译腔' },
        consistencyLock: { passed: true, reason: '' },
        outlineLock: { passed: true, reason: '' },
        actionableFeedback: '改善文笔',
      });

      const stylePassed = hardResult.passed && llmAudit.styleLock.passed;
      expect(stylePassed).toBe(false);
    });

    it('both pass → overall passes', () => {
      const hardResult = runStyleLockHard('干净的正文。');
      const llmAudit = parseSceneAuditResult({
        styleLock: { passed: true, reason: '' },
        consistencyLock: { passed: true, reason: '' },
        outlineLock: { passed: true, reason: '' },
        actionableFeedback: '',
      });

      const stylePassed = hardResult.passed && llmAudit.styleLock.passed;
      const overallPassed = stylePassed && llmAudit.consistencyLock.passed && llmAudit.outlineLock.passed;
      expect(overallPassed).toBe(true);
    });

    it('both fail → collects all reasons', () => {
      const hardResult = runStyleLockHard('命运的齿轮开始转动，那一刻他明白了。');
      const llmAudit = parseSceneAuditResult({
        styleLock: { passed: false, reason: '废话太多' },
        consistencyLock: { passed: false, reason: '角色矛盾' },
        outlineLock: { passed: false, reason: '偏离大纲' },
        actionableFeedback: '全面重写',
      });

      const stylePassed = hardResult.passed && llmAudit.styleLock.passed;
      expect(stylePassed).toBe(false);
      expect(hardResult.reason).toContain('命运的齿轮');
      expect(hardResult.reason).toContain('那一刻');
      expect(llmAudit.consistencyLock.passed).toBe(false);
      expect(llmAudit.outlineLock.passed).toBe(false);
    });
  });
});
