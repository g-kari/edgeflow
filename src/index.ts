import type { WorkflowParams } from './workflow';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EXECUTE: Workflow<WorkflowParams>;
  [key: string]: unknown;
}

export { EdgeflowWorkflow } from './workflow';

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
