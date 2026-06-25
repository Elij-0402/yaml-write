import { describe, it, expect } from 'vitest';
import { sha256Hex, formatWordCount } from './util';

// 纯逻辑测试：内容指纹（Web Crypto，node ≥18 提供 globalThis.crypto.subtle）+ 字数格式化。

describe('sha256Hex', () => {
  it('匹配已知向量：空串与 "abc"', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('输出恒为 64 位小写十六进制', async () => {
    const hex = await sha256Hex('创作 DNA 工坊');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('同输入恒等、异输入相异（确定性指纹）', async () => {
    expect(await sha256Hex('第一章')).toBe(await sha256Hex('第一章'));
    expect(await sha256Hex('第一章')).not.toBe(await sha256Hex('第二章'));
  });

  it('对多字节中文按 UTF-8 编码后摘要（非 UTF-16）', async () => {
    // "你好" 的 UTF-8 SHA-256 固定向量，验证 TextEncoder 路径。
    expect(await sha256Hex('你好')).toBe(
      '670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e',
    );
  });
});

describe('formatWordCount', () => {
  it('不足 1 万：原样数字字符串', () => {
    expect(formatWordCount(0)).toBe('0');
    expect(formatWordCount(1)).toBe('1');
    expect(formatWordCount(9999)).toBe('9999');
  });

  it('恰好 1 万为边界（含端）：进入「万」表示', () => {
    expect(formatWordCount(10000)).toBe('1.0万');
  });

  it('≥1 万：以万为单位、保留 1 位小数', () => {
    expect(formatWordCount(12345)).toBe('1.2万');
    expect(formatWordCount(100000)).toBe('10.0万');
    expect(formatWordCount(1234567)).toBe('123.5万');
  });

  it('四舍五入到 1 位小数（toFixed 行为）', () => {
    expect(formatWordCount(15500)).toBe('1.6万'); // 1.55 → 1.6
    expect(formatWordCount(15400)).toBe('1.5万'); // 1.54 → 1.5
  });
});
