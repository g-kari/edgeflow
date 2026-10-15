import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage';

const definition = {
  schemaVersion: 1, id: 'wf-1', name: 'demo',
  trigger: { type: 'cron', cron: '0 9 * * *' },
  nodes: [{ id: 'a', type: 'transform', name: 'A', params: { value: 1 } }],
  edges: [],
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM run_steps');
  await env.DB.exec('DELETE FROM runs');
  await env.DB.exec('DELETE FROM workflows');
  await env.DB.prepare(
    'INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES (?,?,?,?,1,?)',
  ).bind('wf-1', 'demo', JSON.stringify(definition), '0 9 * * *', '2026-07-30T00:00:00Z').run();
});

describe('Storage', () => {
  it('ワークフローを読み込んで検証する', async () => {
    const wf = await new Storage(env).loadWorkflow('wf-1');
    expect(wf.name).toBe('demo');
  });

  it('存在しない ID はエラー', async () => {
    await expect(new Storage(env).loadWorkflow('zzz')).rejects.toThrow(/見つかりません/);
  });

  it('cron ワークフローを列挙する', async () => {
    const list = await new Storage(env).listCronWorkflows();
    expect(list.map((w) => w.id)).toEqual(['wf-1']);
  });

  it('実行を開始して終了できる', async () => {
    const s = new Storage(env);
    await s.startRun('run-1', 'wf-1', 'cron', '2026-07-30T00:00:00Z');
    await s.finishRun('run-1', 'success', '2026-07-30T00:00:01Z');
    const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind('run-1').first();
    expect(row?.status).toBe('success');
  });

  it('小さい出力は inline で返す', async () => {
    const out = await new Storage(env).saveOutput('run-1', 'a', { a: 1 });
    expect(out.kind).toBe('inline');
    expect(await new Storage(env).readOutput(out)).toEqual({ a: 1 });
  });

  it('512KB 超の出力は R2 に退避する', async () => {
    const big = { blob: 'x'.repeat(600 * 1024) };
    const s = new Storage(env);
    const out = await s.saveOutput('run-1', 'a', big);
    expect(out.kind).toBe('r2');
    expect(await s.readOutput(out)).toEqual(big);
  });

  it('ステップを記録し preview を切り詰める', async () => {
    const s = new Storage(env);
    await s.startRun('run-1', 'wf-1', 'cron', '2026-07-30T00:00:00Z');
    await s.recordStep('run-1', { id: 'a', name: 'A' }, 'success', {
      attempts: 1, durationMs: 12, output: { text: 'y'.repeat(10_000) },
    });
    const row = await env.DB.prepare(
      'SELECT output_preview, status FROM run_steps WHERE run_id = ? AND node_id = ?',
    ).bind('run-1', 'a').first<{ output_preview: string; status: string }>();
    expect(row?.status).toBe('success');
    expect(row!.output_preview.length).toBeLessThanOrEqual(4096);
  });
});
