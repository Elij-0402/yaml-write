import { describe, it, expect } from 'vitest';
import {
  PROVIDER_REGISTRY,
  isProviderId,
  getProviderMeta,
  listProviderMetas,
  createDefaultProviderProfiles,
  normalizeLegacyProviderProfile,
  type ProviderId,
} from './llmProviders';

// 纯逻辑测试：多 provider 注册表 + BYOK profile 工厂 / 旧版兼容迁移（node 环境，无依赖）。

const ALL_IDS: ProviderId[] = ['openai', 'deepseek', 'gemini', 'siliconflow', 'ollama', 'custom'];

describe('PROVIDER_REGISTRY', () => {
  it('注册了全部 6 个 provider，且 meta.id 与键一致', () => {
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual([...ALL_IDS].sort());
    for (const id of ALL_IDS) {
      expect(PROVIDER_REGISTRY[id].id).toBe(id);
    }
  });

  it('仅 ollama 不需要 API Key（requiresApiKey:false），其余皆需', () => {
    expect(PROVIDER_REGISTRY.ollama.requiresApiKey).toBe(false);
    for (const id of ALL_IDS.filter((x) => x !== 'ollama')) {
      expect(PROVIDER_REGISTRY[id].requiresApiKey).toBe(true);
    }
  });

  it('custom 为空白中转：defaultBaseUrl / defaultModel 皆为空，且无预设模型', () => {
    expect(PROVIDER_REGISTRY.custom.defaultBaseUrl).toBe('');
    expect(PROVIDER_REGISTRY.custom.defaultModel).toBe('');
    expect(PROVIDER_REGISTRY.custom.modelPresets).toEqual([]);
  });
});

describe('isProviderId', () => {
  it('接受全部 6 个合法 id', () => {
    for (const id of ALL_IDS) expect(isProviderId(id)).toBe(true);
  });

  it('拒绝未知字符串与非字符串值', () => {
    expect(isProviderId('anthropic')).toBe(false);
    expect(isProviderId('')).toBe(false);
    expect(isProviderId(null)).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
    expect(isProviderId(123)).toBe(false);
    expect(isProviderId({})).toBe(false);
  });

  it('不被原型链上的属性误判（hasOwn 而非 in）', () => {
    expect(isProviderId('toString')).toBe(false);
    expect(isProviderId('constructor')).toBe(false);
  });
});

describe('getProviderMeta', () => {
  it('返回对应 provider 的 meta 引用', () => {
    expect(getProviderMeta('openai')).toBe(PROVIDER_REGISTRY.openai);
    expect(getProviderMeta('siliconflow').name).toBe('硅基流动');
  });
});

describe('listProviderMetas', () => {
  it('按注册表顺序返回全部 6 个 meta', () => {
    const metas = listProviderMetas();
    expect(metas).toHaveLength(6);
    expect(metas.map((m) => m.id)).toEqual(ALL_IDS);
  });
});

describe('createDefaultProviderProfiles', () => {
  it('为每个 provider 生成默认 profile：空 apiKey + 注册表默认 baseUrl/model', () => {
    const profiles = createDefaultProviderProfiles();
    expect(Object.keys(profiles).sort()).toEqual([...ALL_IDS].sort());
    for (const id of ALL_IDS) {
      expect(profiles[id].apiKey).toBe('');
      expect(profiles[id].baseUrl).toBe(PROVIDER_REGISTRY[id].defaultBaseUrl);
      expect(profiles[id].model).toBe(PROVIDER_REGISTRY[id].defaultModel);
    }
  });

  it('openai 默认指向官方 v1 端点与 gpt-4o', () => {
    const profiles = createDefaultProviderProfiles();
    expect(profiles.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(profiles.openai.model).toBe('gpt-4o');
  });
});

describe('normalizeLegacyProviderProfile', () => {
  const profile = (patch: Partial<{ apiKey: string; baseUrl: string; model: string }> = {}) => ({
    apiKey: 'sk-test',
    baseUrl: '',
    model: '',
    ...patch,
  });

  it('非 deepseek 的 provider 原样返回（不迁移）', () => {
    const p = profile({ baseUrl: 'https://api.openai.com/v1', model: 'deepseek-chat' });
    expect(normalizeLegacyProviderProfile('openai', p)).toBe(p);
  });

  it('deepseek 旧 baseUrl（.com/v1）迁移为 .com', () => {
    const out = normalizeLegacyProviderProfile('deepseek', profile({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    }));
    expect(out.baseUrl).toBe('https://api.deepseek.com');
  });

  it('deepseek 旧 model（deepseek-chat）迁移为 deepseek-v4-flash', () => {
    const out = normalizeLegacyProviderProfile('deepseek', profile({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    }));
    expect(out.model).toBe('deepseek-v4-flash');
  });

  it('deepseek 已是新值时不改动，且始终保留 apiKey', () => {
    const out = normalizeLegacyProviderProfile('deepseek', profile({
      apiKey: 'sk-keep',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
    }));
    expect(out.baseUrl).toBe('https://api.deepseek.com');
    expect(out.model).toBe('deepseek-reasoner');
    expect(out.apiKey).toBe('sk-keep');
  });
});
