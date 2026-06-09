import { describe, it, expect } from 'vitest';
import { parseSseBuffer, readApiErrorMessage, isTransientStatus } from './llmClient';

// 核心网络层的纯逻辑：SSE 分帧 / 错误解包 / 瞬时-致命状态分类（node 环境，无 jsdom）。

describe('parseSseBuffer', () => {
  it('parses a single complete delta frame', () => {
    const { events, rest } = parseSseBuffer('event: delta\ndata: {"text":"hi"}\n\n');
    expect(rest).toBe('');
    expect(events).toEqual([{ event: 'delta', payload: { text: 'hi' } }]);
  });

  it('parses multiple frames and keeps a half-frame as rest (半包续接)', () => {
    const { events, rest } = parseSseBuffer(
      'event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\nevent: do',
    );
    expect(events.map((e) => e.payload.text)).toEqual(['a', 'b']);
    expect(rest).toBe('event: do');
  });

  it('emits an error event for malformed JSON in a data line', () => {
    const { events } = parseSseBuffer('event: delta\ndata: {bad json}\n\n');
    expect(events[0].event).toBe('error');
    expect(events[0].payload.code).toBe('invalid_stream_payload');
  });

  it('defaults the event name to message when only a data line is present', () => {
    const { events } = parseSseBuffer('data: {"ok":true}\n\n');
    expect(events[0].event).toBe('message');
    expect(events[0].payload.ok).toBe(true);
  });

  it('skips a frame that carries no data line', () => {
    const { events, rest } = parseSseBuffer('event: ping\n\n');
    expect(events).toEqual([]);
    expect(rest).toBe('');
  });
});

describe('isTransientStatus', () => {
  it('treats 5xx + proxy timeouts as transient (可退避重试)', () => {
    [500, 502, 503, 504].forEach((s) => expect(isTransientStatus(s)).toBe(true));
  });
  it('treats config / capability errors as non-transient (致命)', () => {
    [400, 401, 403, 404, 413, 422, 429].forEach((s) => expect(isTransientStatus(s)).toBe(false));
  });
});

describe('readApiErrorMessage', () => {
  const mockResponse = (status: number, body: string): Response =>
    ({ status, text: async () => body } as unknown as Response);

  it('unwraps {error:{message}}', async () => {
    const msg = await readApiErrorMessage(mockResponse(400, JSON.stringify({ error: { code: 'x', message: '密钥无效' } })));
    expect(msg).toBe('密钥无效');
  });

  it('falls back to message / detail fields', async () => {
    expect(await readApiErrorMessage(mockResponse(400, JSON.stringify({ detail: 'boom' })))).toBe('boom');
    expect(await readApiErrorMessage(mockResponse(400, JSON.stringify({ message: 'oops' })))).toBe('oops');
  });

  it('uses status + trimmed text for non-JSON bodies', async () => {
    const msg = await readApiErrorMessage(mockResponse(500, 'Internal Error'));
    expect(msg).toContain('HTTP 500');
    expect(msg).toContain('Internal Error');
  });

  it('uses status + fallback for an empty body', async () => {
    const msg = await readApiErrorMessage(mockResponse(503, ''), '接口请求失败');
    expect(msg).toContain('HTTP 503');
    expect(msg).toContain('接口请求失败');
  });
});
