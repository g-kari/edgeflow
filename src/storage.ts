import type { Env } from './index';
import { parseWorkflow, type Workflow } from './schema';

const INLINE_LIMIT_BYTES = 512 * 1024;
const PREVIEW_LIMIT_CHARS = 4096;

export type StepOutput =
  | { kind: 'inline'; value: unknown }
  | { kind: 'r2'; key: string; bytes: number };

export class Storage {
  constructor(private readonly env: Env) {}

  async loadWorkflow(id: string): Promise<Workflow> {
    const row = await this.env.DB
      .prepare('SELECT definition FROM workflows WHERE id = ? AND enabled = 1')
      .bind(id)
      .first<{ definition: string }>();
    if (!row) throw new Error(`ワークフローが見つかりません: ${id}`);
    return parseWorkflow(JSON.parse(row.definition));
  }

  async listCronWorkflows(): Promise<Workflow[]> {
    const { results } = await this.env.DB
      .prepare('SELECT definition FROM workflows WHERE enabled = 1 AND cron IS NOT NULL')
      .all<{ definition: string }>();
    return results.map((r) => parseWorkflow(JSON.parse(r.definition)));
  }

  async startRun(runId: string, workflowId: string, triggerType: string, startedAt: string): Promise<void> {
    await this.env.DB.prepare(
      'INSERT INTO runs (id, workflow_id, status, trigger_type, started_at) VALUES (?,?,?,?,?)',
    ).bind(runId, workflowId, 'running', triggerType, startedAt).run();
  }

  async finishRun(
    runId: string,
    status: 'success' | 'failed',
    finishedAt: string,
    errorSummary?: string,
  ): Promise<void> {
    await this.env.DB.prepare(
      'UPDATE runs SET status = ?, finished_at = ?, error_summary = ? WHERE id = ?',
    ).bind(status, finishedAt, errorSummary ?? null, runId).run();
  }

  async recordStep(
    runId: string,
    node: { id: string; name: string },
    status: 'success' | 'failed' | 'skipped',
    info: { attempts: number; durationMs: number; output?: unknown; error?: string },
  ): Promise<void> {
    // D1 は行 2MB 上限があり、スキャン行数で課金される。preview は必ず切り詰める。
    const preview = info.output === undefined
      ? null
      : JSON.stringify(info.output).slice(0, PREVIEW_LIMIT_CHARS);
    await this.env.DB.prepare(
      `INSERT INTO run_steps (run_id, node_id, node_name, status, attempts, duration_ms, output_preview, error)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (run_id, node_id) DO UPDATE SET
         status = excluded.status, attempts = excluded.attempts,
         duration_ms = excluded.duration_ms, output_preview = excluded.output_preview,
         error = excluded.error`,
    ).bind(runId, node.id, node.name, status, info.attempts, info.durationMs, preview, info.error ?? null).run();
  }

  // step.do() の戻り値は 1MiB 上限。余裕を見て 512KB で R2 に切り替える。
  async saveOutput(runId: string, nodeId: string, value: unknown): Promise<StepOutput> {
    const json = JSON.stringify(value ?? null);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes <= INLINE_LIMIT_BYTES) return { kind: 'inline', value };
    const key = `runs/${runId}/${nodeId}.json`;
    await this.env.BUCKET.put(key, json, { httpMetadata: { contentType: 'application/json' } });
    return { kind: 'r2', key, bytes };
  }

  async readOutput(out: StepOutput): Promise<unknown> {
    if (out.kind === 'inline') return out.value;
    const obj = await this.env.BUCKET.get(out.key);
    if (!obj) throw new Error(`R2 のオブジェクトが見つかりません: ${out.key}`);
    return JSON.parse(await obj.text());
  }
}
