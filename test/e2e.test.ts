import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import definition from '../fixtures/daily-report.json';
import { executeWorkflow } from '../src/workflow';

const fakeStep = () => {
  const names: string[] = [];
  return {
    names,
    async do<T>(name: string, _options: unknown, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      return fn();
    },
  };
};

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM run_steps').run();
  await env.DB.prepare('DELETE FROM runs').run();
  await env.DB.prepare('DELETE FROM workflows').run();
  await env.DB.prepare(
    'INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES (?,?,?,?,1,?)',
  ).bind(
    'daily-report',
    'daily-report',
    JSON.stringify(definition),
    '0 9 * * *',
    '2026-07-30T00:00:00Z',
  ).run();

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('api.github.com')) {
      return new Response(JSON.stringify({ stargazers_count: 6000 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('daily-report ワークフロー', () => {
  it('4 ノードを通って成功する', async () => {
    const step = fakeStep();
    const workflowEnv = {
      DB: env.DB,
      BUCKET: env.BUCKET,
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/demo/token',
    };
    await executeWorkflow({
      env: workflowEnv,
      step: step as any,
      runId: 'e2e-1',
      workflowId: 'daily-report',
      triggerType: 'cron',
      nowIso: '2026-07-30T09:00:00.000Z',
    });

    expect(step.names).toEqual(['Fetch', 'HasStars', 'Compose', 'Post']);

    const run = await env.DB.prepare('SELECT status FROM runs WHERE id = ?')
      .bind('e2e-1').first<{ status: string }>();
    expect(run?.status).toBe('success');

    const compose = await env.DB.prepare(
      'SELECT output_preview FROM run_steps WHERE run_id = ? AND node_id = ?',
    ).bind('e2e-1', 'compose').first<{ output_preview: string }>();
    expect(JSON.parse(compose!.output_preview))
      .toBe('workerd は 6000 スターです（2026-07-30T09:00:00.000Z）');
  });
});
