import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('ヘルスチェックが 200 と ok を返す', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('D1 バインディングが使える', async () => {
    const r = await env.DB.prepare('SELECT 1 AS n').first<{ n: number }>();
    expect(r?.n).toBe(1);
  });

  it('R2 バインディングが使える', async () => {
    await env.BUCKET.put('smoke.txt', 'hello');
    const obj = await env.BUCKET.get('smoke.txt');
    expect(await obj?.text()).toBe('hello');
  });
});
