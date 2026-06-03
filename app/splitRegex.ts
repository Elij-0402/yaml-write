// 分章正则的校验与规范化 —— 单一形状源（bundle 侧）。
// 此前 NovelUploader.tsx 与 public/workers/novel-parser-worker.js 各存一份（第三拷贝）；
// 现 NovelUploader 改为从此 import，消除其本地副本。worker（classic、静态文件、不在 webpack 图里）
// 仍内联一份；如后续把 worker 迁为 Module Worker，即可让其一并 import 本模块，彻底单一源。

export const DEFAULT_CUSTOM_REGEX = '^\\s*(第\\s*[零〇一二三四五六七八九十百千万两\\d]+\\s*[章节回卷篇幕节].*?)$';
export const MAX_CUSTOM_REGEX_LENGTH = 300;

// 把用户正则规范成「单行匹配」：强制 m 标志、剥离 g/y（全局/粘附会污染调用方的 lastIndex 语义）。
export function toLineRegex(pattern: string): RegExp {
  if (!pattern.trim()) throw new Error('empty regex pattern');
  const inputRegex = new RegExp(pattern, 'm');
  const safeFlags = inputRegex.flags.replace('g', '').replace('y', '');
  return new RegExp(inputRegex.source, safeFlags);
}

// 粗筛灾难性回溯：嵌套量词 / .*|.+ 包在分组里又被外层量词重复。
export function hasNestedQuantifierRisk(pattern: string): boolean {
  const nestedQuantifierRules = [
    /\((?:\\.|[^()]){0,240}(?:\*|\+|\{\d*,?\d*\})(?:\\.|[^()]){0,240}\)\s*(?:\*|\+|\{\d*,?\d*\})/,
    /\((?:\\.|[^()]){0,240}\.\*(?:\\.|[^()]){0,240}\)\s*(?:\*|\+)/,
    /\((?:\\.|[^()]){0,240}\.\+(?:\\.|[^()]){0,240}\)\s*(?:\*|\+)/,
  ];
  return nestedQuantifierRules.some((rule) => rule.test(pattern));
}

// 校验自定义分章正则：非空、长度上限、禁跨行、无高危嵌套量词、可编译、不匹配空串。返回错误文案或 null（通过）。
export function validateLineRegex(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) return '请填写正则';
  if (trimmed.length > MAX_CUSTOM_REGEX_LENGTH) return '正则过长';

  const blockedPatterns = [/\\n|\\r/, /\r|\n/, /\[\\s\\S\]/, /\(\?:\.\|\\n\)/, /\(\?s[:)]/, /\\A|\\Z/];
  if (blockedPatterns.some((rule) => rule.test(pattern))) return '不支持跨行正则';
  if (hasNestedQuantifierRisk(trimmed)) return '正则包含高风险嵌套量词';

  try {
    const regex = toLineRegex(trimmed);
    const match = regex.exec('');
    if (match && match[0].length === 0) return '正则不能匹配空字符串';
  } catch {
    return '正则无效';
  }
  return null;
}
