import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebouncer, resolveExternalSync } from './editorOps';

// 纯逻辑「尾沿防抖器」单测（node 环境，假定时器驱动）。
// 覆盖：延迟后才触发、连续调用只取最后一次、cancel/flush、零/边界 delay、独立周期再装填。
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncer', () => {
  it('fires only after the delay elapses — once, with the scheduled value', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, 1000);
    d.schedule('a');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('coalesces rapid successive calls into a single trailing fire with the last value', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, 1000);
    d.schedule('a');
    d.schedule('b');
    d.schedule('c');
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('resets the countdown on each schedule (a later call extends the wait)', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, 1000);
    d.schedule('a');
    vi.advanceTimersByTime(900);
    d.schedule('b'); // 重置计时：从此刻起重新计 1000ms
    vi.advanceTimersByTime(900);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('cancel() discards the pending call so it never fires, and clears pending', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, 1000);
    d.schedule('a');
    expect(d.pending).toBe(true);
    d.cancel();
    expect(d.pending).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush() fires the pending call immediately, exactly once, and clears pending', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, 1000);
    d.schedule('a');
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
    expect(d.pending).toBe(false);
    // 原计时器不应再补发一次
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing pending is a no-op', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, 1000);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending).toBe(false);
  });

  it('defaults to a 1000ms delay when none is supplied', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn);
    d.schedule('x');
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledWith('x');
  });

  it('supports a zero delay — still asynchronous, fires on the next macrotask tick', () => {
    const fn = vi.fn();
    const d = createDebouncer<number>(fn, 0);
    d.schedule(42);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it('treats a negative delay as zero (boundary)', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, -50);
    d.schedule('neg');
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('neg');
  });

  it('re-arms cleanly for an independent cycle after firing', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, 1000);
    d.schedule('first');
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenLastCalledWith('first');
    expect(d.pending).toBe(false);
    d.schedule('second');
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('second');
  });
});

// 焦点隔离核心判定：把「自身防抖写回的回声」与「外部权威新值」区分开。
// 这些用例锁定 review 修复（#1 流式污染 / #2 跨创作串写 / #4 回声误吞）的不变量，防其悄悄回归。
describe('resolveExternalSync', () => {
  it('treats the bounce-back of our own commit as an echo: skip DOM write, keep any new pending', () => {
    // 正常提交「ab」后，prose 折返为 initialText='ab'，DOM 也已是 'ab' → 跳过，不作废 pending。
    const d = resolveExternalSync({ initialText: 'ab', domValue: 'ab', echo: 'ab', sceneChanged: false });
    expect(d).toEqual({ isEcho: true, cancelPending: false, writeDom: false });
  });

  it('still recognises the echo even if the user typed more before the bounce (no revert, no cursor jump)', () => {
    // 提交「ab」(echo='ab')，折返前用户又敲成 'abc' → 仍认作回声并跳过：不写回 'ab'、不作废 'abc' 的 pending。
    // 这是 echoRef 优于旧 committedRef 的关键：旧逻辑此处会把 'abc' 回灌成 'ab' 并跳光标。
    const d = resolveExternalSync({ initialText: 'ab', domValue: 'abc', echo: 'ab', sceneChanged: false });
    expect(d).toEqual({ isEcho: true, cancelPending: false, writeDom: false });
  });

  it('an empty-string commit is a valid echo (not confused with "no echo")', () => {
    const d = resolveExternalSync({ initialText: '', domValue: '', echo: '', sceneChanged: false });
    expect(d.isEcho).toBe(true);
    expect(d.writeDom).toBe(false);
  });

  it('an external new value supersedes the local buffer: cancel pending + write DOM (#1/#2 root cause)', () => {
    // 切创作 / 接受改写：外部值 'X' 取代用户正在编辑的 'ab' → 必须作废挂起写回并同步 DOM。
    const d = resolveExternalSync({ initialText: 'X', domValue: 'ab', echo: null, sceneChanged: false });
    expect(d).toEqual({ isEcho: false, cancelPending: true, writeDom: true });
  });

  it('streaming reset to "" cancels a pending typed buffer and clears the DOM (#1)', () => {
    const d = resolveExternalSync({ initialText: '', domValue: 'abc', echo: null, sceneChanged: false });
    expect(d).toEqual({ isEcho: false, cancelPending: true, writeDom: true });
  });

  it('#4 regression: external value equal to the LAST committed value (but not the live echo) still syncs', () => {
    // 用户提交过 'A'（echo 早已被消费 → null），又敲成 'AB'(DOM)；外部恢复历史版恰好也是 'A'。
    // 旧 committedRef 等值判定会误判为回声而跳过；现在 echo=null → 按外部值：作废 'AB' 的 pending 并把 DOM 写回 'A'。
    const d = resolveExternalSync({ initialText: 'A', domValue: 'AB', echo: null, sceneChanged: false });
    expect(d).toEqual({ isEcho: false, cancelPending: true, writeDom: true });
  });

  it('an external value already equal to the DOM cancels stale pending but skips a needless DOM write', () => {
    const d = resolveExternalSync({ initialText: 'A', domValue: 'A', echo: null, sceneChanged: false });
    expect(d).toEqual({ isEcho: false, cancelPending: true, writeDom: false });
  });

  it('a scene switch is always external, even if the new text equals the live echo value', () => {
    // 切场景时不让回声判定误吞：echo==='A' 且 initialText==='A'，但 sceneChanged → 按外部处理。
    const sameValue = resolveExternalSync({ initialText: 'A', domValue: 'A', echo: 'A', sceneChanged: true });
    expect(sameValue).toEqual({ isEcho: false, cancelPending: true, writeDom: false });
    const diffValue = resolveExternalSync({ initialText: 'A', domValue: 'B', echo: 'A', sceneChanged: true });
    expect(diffValue).toEqual({ isEcho: false, cancelPending: true, writeDom: true });
  });

  it('with no echo recorded, any initialText change is external', () => {
    const d = resolveExternalSync({ initialText: 'hello', domValue: 'hell', echo: null, sceneChanged: false });
    expect(d.isEcho).toBe(false);
    expect(d.cancelPending).toBe(true);
    expect(d.writeDom).toBe(true);
  });
});
