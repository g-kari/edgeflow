import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError as CfNonRetryableError } from 'cloudflare:workflows';
import { NonRetryableError } from './errors';
import { ExpressionEvaluator, type ExpressionScope } from './expression';
import { ExecutionPlanner } from './graph';
import { NODE_IMPLS } from './nodes';
import type { ParamValue, Workflow, WorkflowNode } from './schema';
import { Storage } from './storage';
import type { Env } from './index';

export type WorkflowParams = { workflowId: string; triggerType: 'cron' | 'manual' };

export type ExecuteDeps = {
  env: Env;
  step: Pick<WorkflowStep, 'do'>;
  runId: string;
  workflowId: string;
  triggerType: 'cron' | 'manual';
  nowIso: string;
};

export class EdgeflowWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    await executeWorkflow({
      env: this.env,
      step,
      runId: event.instanceId,
      workflowId: event.payload.workflowId,
      triggerType: event.payload.triggerType,
      // $now は実行開始時に 1 度だけ確定させ全ノードに配る。
      // Workers のタイマーは最後の I/O 時点で止まるため、ノードごとに取ると値が揺れる。
      nowIso: new Date(event.timestamp).toISOString(),
    });
  }
}

export async function executeWorkflow(deps: ExecuteDeps): Promise<void> {
  const { env, step, runId, workflowId, triggerType, nowIso } = deps;
  const storage = new Storage(env);
  const wf = await storage.loadWorkflow(workflowId);

  await storage.startRun(runId, workflowId, triggerType, nowIso);

  const evaluator = new ExpressionEvaluator();
  const planner = new ExecutionPlanner(wf);
  const outputs: Record<string, unknown> = {};
  let lastOutput: unknown = null;

  try {
    let node = planner.next();
    while (node !== null) {
      const current = node;
      const startedAt = Date.now();

      const result = await step.do(
        current.name,
        {
          retries: {
            limit: current.retry?.limit ?? wf.defaultRetryLimit ?? 3,
            delay: 10_000,
            backoff: 'exponential',
          },
          timeout: '2 minutes',
        },
        async () => runNode(wf, current, evaluator, {
          $json: lastOutput,
          $nodes: outputs,
          $secrets: secretsOf(env),
          $now: { iso: nowIso, date: new Date(nowIso) },
          $run: { id: runId, workflowName: wf.name, attempt: 1 },
        }),
      );

      const saved = await storage.saveOutput(runId, current.id, result.output);
      await storage.recordStep(runId, current, 'success', {
        attempts: 1,
        durationMs: Date.now() - startedAt,
        output: result.output,
      });

      outputs[current.name] = result.output;
      lastOutput = await storage.readOutput(saved);
      planner.complete(current.id, { branch: result.branch });
      node = planner.next();
    }

    for (const id of planner.skipped()) {
      const n = wf.nodes.find((x) => x.id === id)!;
      await storage.recordStep(runId, n, 'skipped', { attempts: 0, durationMs: 0 });
    }

    await storage.finishRun(runId, 'success', new Date().toISOString());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await storage.finishRun(runId, 'failed', new Date().toISOString(), message.slice(0, 500));
    throw e;
  }
}

async function runNode(
  wf: Workflow,
  node: WorkflowNode,
  evaluator: ExpressionEvaluator,
  scope: ExpressionScope,
) {
  let params: Record<string, unknown>;
  try {
    params = resolveParams(node.params, evaluator, scope);
  } catch (e) {
    // 式のエラーはリトライしても直らない。
    throw new CfNonRetryableError(e instanceof Error ? e.message : String(e));
  }

  try {
    return await NODE_IMPLS[node.type]({
      params,
      input: scope.$json,
      run: { id: scope.$run.id, workflowName: wf.name, attempt: scope.$run.attempt, now: scope.$now },
    });
  } catch (e) {
    if (e instanceof NonRetryableError) throw new CfNonRetryableError(e.message);
    throw e;
  }
}

// 式は必ずノード呼び出しの前に解決する。ノード実装は $expr の存在を知らない。
function resolveParams(
  params: Record<string, ParamValue>,
  evaluator: ExpressionEvaluator,
  scope: ExpressionScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = isExpr(value) ? evaluator.evaluate(value.$expr, scope) : value;
  }
  return out;
}

function isExpr(v: ParamValue): v is { $expr: string } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && '$expr' in v;
}

// Wrangler Secrets は env に文字列として現れる。バインディング（DB / BUCKET / EXECUTE）は除く。
function secretsOf(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
