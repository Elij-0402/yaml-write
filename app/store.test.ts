import { describe, it, expect } from 'vitest';
import { encryptKey, decryptKey, normalizeLLMConfig } from './store';

// BYOK key 的混淆往返 + LLM 配置迁移：regress 会丢 key 或把乱码发往后端，故是高价值纯逻辑测试。

describe('encryptKey / decryptKey round-trip', () => {
  it('round-trips an ASCII key behind the x1: sentinel (密文不含明文)', () => {
    const k = 'sk-abc123XYZ';
    const enc = encryptKey(k);
    expect(enc.startsWith('x1:')).toBe(true);
    expect(enc).not.toContain(k);
    expect(decryptKey(enc)).toBe(k);
  });

  it('round-trips a non-ASCII (UTF-8) key', () => {
    const k = '密钥-Schlüssel-🔑';
    expect(decryptKey(encryptKey(k))).toBe(k);
  });

  it('returns empty string for empty input on both directions', () => {
    expect(encryptKey('')).toBe('');
    expect(decryptKey('')).toBe('');
  });

  it('treats a non-sentinel string as legacy plaintext (returns as-is)', () => {
    expect(decryptKey('sk-legacy-plaintext')).toBe('sk-legacy-plaintext');
  });

  it('decrypts corrupt ciphertext to empty string (never re-sent as garbage)', () => {
    expect(decryptKey('x1:@@@@not-base64@@@@')).toBe('');
  });
});

describe('normalizeLLMConfig', () => {
  it('returns defaults for non-object input', () => {
    const cfg = normalizeLLMConfig(null);
    expect(cfg.activeProvider).toBe('deepseek');
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.providerProfiles.openai).toBeDefined();
  });

  it('keeps a valid new-shape config and clamps an out-of-range temperature', () => {
    const cfg = normalizeLLMConfig({ activeProvider: 'openai', providerProfiles: {}, temperature: 9 });
    expect(cfg.activeProvider).toBe('openai');
    expect(cfg.temperature).toBe(1.5);
  });

  it('migrates a legacy flat shape (provider/apiKey/baseUrl/model)', () => {
    const cfg = normalizeLLMConfig({ provider: 'openai', apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
    expect(cfg.activeProvider).toBe('openai');
    expect(cfg.providerProfiles.openai.apiKey).toBe('sk-x');
    expect(cfg.providerProfiles.openai.model).toBe('gpt-4o');
  });

  it('falls back to deepseek for an unknown provider id', () => {
    const cfg = normalizeLLMConfig({ activeProvider: 'bogus', providerProfiles: {}, temperature: 0.5 });
    expect(cfg.activeProvider).toBe('deepseek');
  });
});
