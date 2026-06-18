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

describe('AC2 — 持久化文档无明文 key（回归守卫）', () => {
  // store.ts 经 createJSONStorage 的 replacer/reviver（store.ts:266-270）在落盘/读盘边界对每个 apiKey
  // 调 encryptKey/decryptKey。上面的逐值往返只覆盖单个密文；这里补齐 AC2 的文档级不变量：整个
  // novel-fusion-store 文档串里只有 x1: 密文、绝无明文 key 子串。镜像该 replacer，用真实导出的 encryptKey，
  // 故若混淆被误删（encryptKey 直返明文）此断言会立即失败。
  const persistReplacer = (key: string, value: unknown) =>
    key === 'apiKey' && typeof value === 'string' && value ? encryptKey(value) : value;

  it('多服务商配置序列化后零明文泄露，且可逆还原', () => {
    const PLAINTEXT_ASCII = 'sk-live-DO-NOT-LEAK-77881234';
    const PLAINTEXT_UTF8 = '密钥-Schlüssel-🔑-abcd';
    const state = {
      llmConfig: {
        activeProvider: 'openai',
        providerProfiles: {
          openai: { apiKey: PLAINTEXT_ASCII, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
          deepseek: { apiKey: PLAINTEXT_UTF8, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        },
        temperature: 0.7,
      },
    };

    const persisted = JSON.stringify({ state, version: 6 }, persistReplacer);

    // 落盘文档绝不得出现任一明文 key 子串……
    expect(persisted).not.toContain(PLAINTEXT_ASCII);
    expect(persisted).not.toContain(PLAINTEXT_UTF8);
    // ……连特征片段也不残留（'-' / 'ü' 不在 base64 字母表，密文不可能巧合命中）。
    expect(persisted).not.toContain('sk-live');
    expect(persisted).not.toContain('Schlüssel');

    const profiles = JSON.parse(persisted).state.llmConfig.providerProfiles;
    // 每个 apiKey 都是 x1: 哨兵密文，且可逆还原（reviver 路径），不丢数据。
    expect(profiles.openai.apiKey.startsWith('x1:')).toBe(true);
    expect(profiles.deepseek.apiKey.startsWith('x1:')).toBe(true);
    expect(decryptKey(profiles.openai.apiKey)).toBe(PLAINTEXT_ASCII);
    expect(decryptKey(profiles.deepseek.apiKey)).toBe(PLAINTEXT_UTF8);
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
