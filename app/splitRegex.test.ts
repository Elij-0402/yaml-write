import { describe, it, expect } from 'vitest';
import { validateLineRegex, toLineRegex, DEFAULT_CUSTOM_REGEX } from './splitRegex';

describe('validateLineRegex', () => {
  it('accepts the default chapter regex', () => {
    expect(validateLineRegex(DEFAULT_CUSTOM_REGEX)).toBeNull();
  });

  it('rejects empty / whitespace', () => {
    expect(validateLineRegex('')).toBe('请填写正则');
    expect(validateLineRegex('   ')).toBe('请填写正则');
  });

  it('rejects an over-long pattern', () => {
    expect(validateLineRegex('a'.repeat(301))).toBe('正则过长');
  });

  it('rejects cross-line constructs', () => {
    expect(validateLineRegex('foo\\nbar')).toBe('不支持跨行正则');
    expect(validateLineRegex('[\\s\\S]+')).toBe('不支持跨行正则');
  });

  it('rejects a high-risk nested quantifier', () => {
    expect(validateLineRegex('^(a+)+$')).toBe('正则包含高风险嵌套量词');
  });

  it('rejects a pattern that matches the empty string', () => {
    expect(validateLineRegex('a*')).toBe('正则不能匹配空字符串');
  });

  it('rejects an uncompilable pattern', () => {
    expect(validateLineRegex('(unclosed')).toBe('正则无效');
  });
});

describe('toLineRegex', () => {
  it('forces the m flag and strips g / y', () => {
    const re = toLineRegex('^第.+章');
    expect(re.flags).toContain('m');
    expect(re.flags).not.toContain('g');
    expect(re.flags).not.toContain('y');
  });

  it('throws on an empty pattern', () => {
    expect(() => toLineRegex('   ')).toThrow();
  });
});
