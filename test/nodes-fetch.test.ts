import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_IMPLS } from '../src/nodes';
import { NonRetryableError } from '../src/errors';
import type { NodeContext } from '../src/nodes/types';

const ctx = (params: Record<string, unknown>, input: unknown = {}): NodeContext => ({
  params, input,
  run: { id: 'r1', workflowName: 'w', attempt: 1, now: { iso: '2026-07-30T00:00:00.000Z', date: new Date(0) } },
});

const mockFetch = (status: number, body: string, contentType = 'application/json') => {
  const spy = vi.fn(async () =>
    new Response(status === 204 ? null : body, {
      status,
      headers: { 'content-type': contentType },
    })) as any;
  vi.stubGlobal('fetch', spy);
  return spy;
};

afterEach(() => vi.unstubAllGlobals());

describe('http ノード', () => {
  it('JSON を parse して status/headers/body を返す', async () => {
    mockFetch(200, JSON.stringify({ items: [1, 2] }));
    const r = await NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }));
    expect(r.output).toMatchObject({ status: 200, body: { items: [1, 2] } });
  });

  it('JSON 以外は文字列で返す', async () => {
    mockFetch(200, 'plain', 'text/plain');
    const r = await NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }));
    expect((r.output as any).body).toBe('plain');
  });

  it('method と body と headers を渡す', async () => {
    const spy = mockFetch(200, '{}');
    await NODE_IMPLS.http(ctx({
      url: 'https://x.test/a', method: 'POST',
      headers: { 'x-token': 'abc' }, body: { a: 1 },
    }));
    const init = spy.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Record<string, string>)['x-token']).toBe('abc');
  });

  it('5xx はリトライ可能な Error を投げる', async () => {
    mockFetch(503, 'oops', 'text/plain');
    await expect(NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }))).rejects.toThrow(/503/);
    await expect(NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }))).rejects.not.toThrow(NonRetryableError);
  });

  it('401 は NonRetryableError', async () => {
    mockFetch(401, 'no', 'text/plain');
    await expect(NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }))).rejects.toThrow(NonRetryableError);
  });

  it('429 はリトライ可能', async () => {
    mockFetch(429, 'slow down', 'text/plain');
    await expect(NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }))).rejects.not.toThrow(NonRetryableError);
  });

  it('url が無ければ NonRetryableError', async () => {
    await expect(NODE_IMPLS.http(ctx({}))).rejects.toThrow(NonRetryableError);
  });
});

describe('notify ノード', () => {
  it('webhookUrl に text を POST する', async () => {
    const spy = mockFetch(200, 'ok', 'text/plain');
    const r = await NODE_IMPLS.notify(ctx({ webhookUrl: 'https://hooks.slack.com/x', text: 'hi' }));
    const init = spy.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ text: 'hi' }));
    expect(r.output).toMatchObject({ status: 200 });
  });

  it('Discord には content を送り、メンションを無効化する', async () => {
    const spy = mockFetch(204, '', 'text/plain');
    await NODE_IMPLS.notify(ctx({
      webhookUrl: 'https://discord.com/api/webhooks/123/token',
      text: '@everyone hi',
    }));
    const init = spy.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(init.body).toBe(JSON.stringify({
      content: '@everyone hi',
      allowed_mentions: { parse: [] },
    }));
  });

  it('https 以外の webhookUrl を拒否する', async () => {
    await expect(NODE_IMPLS.notify(ctx({ webhookUrl: 'http://x.test/', text: 'a' })))
      .rejects.toThrow(NonRetryableError);
  });
});
