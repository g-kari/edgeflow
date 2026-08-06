import type { WorkflowParams } from './workflow';
import { Storage } from './storage';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EXECUTE: Workflow<WorkflowParams>;
  [key: string]: unknown;
}

export { EdgeflowWorkflow } from './workflow';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });

    if (url.pathname === '/runs' && request.method === 'POST') {
      const body = await request.json<{ workflowId?: string }>()
        .catch((): { workflowId?: string } => ({}));
      if (!body.workflowId) {
        return Response.json({ error: 'workflowId が必要です' }, { status: 400 });
      }

      try {
        await new Storage(env).loadWorkflow(body.workflowId);
      } catch {
        return Response.json({ error: 'ワークフローが見つかりません' }, { status: 404 });
      }

      const instance = await env.EXECUTE.create({
        params: { workflowId: body.workflowId, triggerType: 'manual' },
      });
      return Response.json({ runId: instance.id }, { status: 202 });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(startCronWorkflows(env));
  },
} satisfies ExportedHandler<Env>;

async function startCronWorkflows(env: Env): Promise<void> {
  const workflows = await new Storage(env).listCronWorkflows();
  for (const workflow of workflows) {
    await env.EXECUTE.create({
      params: { workflowId: workflow.id, triggerType: 'cron' },
    });
  }
}
