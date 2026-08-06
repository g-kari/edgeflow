import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

const definition = {
  schemaVersion: 1,
  id: 'wf-1',
  name: 'demo',
  trigger: { type: 'manual' },
  nodes: [{ id: 'a', type: 'transform', name: 'A', params: { value: 1 } }],
  edges: [],
};

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM run_steps').run();
  await env.DB.prepare('DELETE FROM runs').run();
  await env.DB.prepare('DELETE FROM workflows').run();
  await env.DB.prepare(
    'INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES (?,?,?,NULL,1,?)',
  ).bind('wf-1', 'demo', JSON.stringify(definition), '2026-07-30T00:00:00Z').run();
});

describe('POST /runs', () => {
  it('runId を返す', async () => {
    const create = vi.fn(async () => ({ id: 'run-1' }));
    const testEnv = { DB: env.DB, BUCKET: env.BUCKET, EXECUTE: { create } } as unknown as Env;
    const res = await worker.fetch(new Request('http://x.test/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    }), testEnv);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: 'run-1' });
    expect(create).toHaveBeenCalledWith({
      params: { workflowId: 'wf-1', triggerType: 'manual' },
    });
  });

  it('存在しない workflowId は 404', async () => {
    const res = await SELF.fetch('http://x.test/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: 'zzz' }),
    });
    expect(res.status).toBe(404);
  });

  it('workflowId が無ければ 400', async () => {
    const res = await SELF.fetch('http://x.test/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
