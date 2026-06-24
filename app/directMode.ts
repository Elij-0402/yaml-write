import { useAppStore } from './store';

// 「直连大模型 vs 走 Python 后端」决策的单一事实源（FusionWorkshop 与 AiAssistant 共用，
// 替代此前各自手搓的探活逻辑，review #9/#10）。
//   · clientDirectMode（强制直连）：纯静态托管（GitHub Pages 等）无后端时由用户在设置里开启 → 恒直连。
//   · 跟随系统：探一次后端可达性（HEAD /api/py/docs，30s 缓存），不可达则回退直连。
// 注意：回退直连会切到「前端直连 + 本地质检」一路。本地质检（evaluatorLocal）已与后端 Pydantic 一样
// 严格 fail-closed（review #3），故回退不会悄悄放宽质检门槛；但它确实绕过后端限流/SSRF/Key 脱敏，
// 仅适用于「本就是用户自己的 Key 直发自己配置的 baseUrl」这一 BYOK 前提。

let backendCheck: { ts: number; ok: boolean } | null = null;
const BACKEND_CHECK_TTL_MS = 30_000;
const BACKEND_PROBE_TIMEOUT_MS = 3_000;

export async function checkBackendReachable(): Promise<boolean> {
  if (useAppStore.getState().clientDirectMode) return false;
  const now = Date.now();
  const cached = backendCheck;
  if (cached && now - cached.ts < BACKEND_CHECK_TTL_MS) return cached.ok;
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), BACKEND_PROBE_TIMEOUT_MS);
    const res = await fetch('/api/py/docs', { signal: ac.signal, method: 'HEAD' });
    clearTimeout(tid);
    backendCheck = { ts: now, ok: res.ok };
    return res.ok;
  } catch {
    backendCheck = { ts: now, ok: false };
    return false;
  }
}

export async function shouldUseDirect(): Promise<boolean> {
  if (useAppStore.getState().clientDirectMode) return true;
  return !(await checkBackendReachable());
}
