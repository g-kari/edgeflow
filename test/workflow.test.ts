import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/workflow';

// step.do() のテストダブル。retries/timeout は無視し、即座に実行する。
const fakeStep = () => {
  const names: string[] = [];
  return {
    names,
    async do<T>(name: string, _opts: unknown, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      return fn();
    },
  };
};

const definition = {
  schemaVersion: 1, id: 'wf-1', name: 'demo',
  trigger: { type: 'manual' },
  nodes: [
    { id: 'a', type: 'transform', name: 'Seed', params: { value: { n: 4 } } },
    { id: 'b', type: 'if', name: 'Check', params: { condition: { $expr: '{{ $json.n > 3 }}' } } },
    { id: 'c', type: 'transform', name: 'Big', params: { value: { $expr: '{{ $json.n * 10 }}' } } },
    { id: 'd', type: 'transform', name: 'Small', params: { value: 0 } },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c', branch: 'true' },
    { from: 'b', to: 'd', branch: 'false' },
  ],
};

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM run_steps').run();
  await env.DB.prepare('DELETE FROM runs').run();
  await env.DB.prepare('DELETE FROM workflows').run();
  await env.DB.prepare(
    'INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES (?,?,?,NULL,1,?)',
  ).bind('wf-1', 'demo', JSON.stringify(definition), '2026-07-30T00:00:00Z').run();
});

describe('executeWorkflow', () => {
  it('分岐を通って成功し、履歴が残る', async () => {
    const step = fakeStep();
    await executeWorkflow({
      env, step: step as any, runId: 'run-1',
      workflowId: 'wf-1', triggerType: 'manual',
      nowIso: '2026-07-30T00:00:00.000Z',
    });

    expect(step.names).toEqual(['Seed', 'Check', 'Big']);

    const run = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind('run-1').first();
    expect(run?.status).toBe('success');

    const { results } = await env.DB.prepare(
      'SELECT node_id, status FROM run_steps WHERE run_id = ? ORDER BY node_id',
    ).bind('run-1').all<{ node_id: string; status: string }>();
    expect(results).toEqual([
      { node_id: 'a', status: 'success' },
      { node_id: 'b', status: 'success' },
      { node_id: 'c', status: 'success' },
      { node_id: 'd', status: 'skipped' },
    ]);
  });

  it('ノードが失敗したら run を failed にする', async () => {
    const step = {
      do(): never {
        throw new Error('node failed');
      },
    };
    await expect(executeWorkflow({
      env, step: step as any, runId: 'run-2',
      workflowId: 'wf-1', triggerType: 'manual',
      nowIso: '2026-07-30T00:00:00.000Z',
    })).rejects.toThrow('node failed');

    const run = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind('run-2').first();
    expect(run?.status).toBe('failed');
  });

  it('$nodes で前のノードの出力を参照できる', async () => {
    const wf = structuredClone(definition);
    wf.nodes[2]!.params = { value: { $expr: "{{ $nodes['Seed'].n + 1 }}" } };
    await env.DB.prepare('UPDATE workflows SET definition = ? WHERE id = ?')
      .bind(JSON.stringify(wf), 'wf-1').run();

    await executeWorkflow({
      env, step: fakeStep() as any, runId: 'run-3',
      workflowId: 'wf-1', triggerType: 'manual',
      nowIso: '2026-07-30T00:00:00.000Z',
    });

    const row = await env.DB.prepare(
      'SELECT output_preview FROM run_steps WHERE run_id = ? AND node_id = ?',
    ).bind('run-3', 'c').first<{ output_preview: string }>();
    expect(JSON.parse(row!.output_preview)).toBe(5);
  });
});
