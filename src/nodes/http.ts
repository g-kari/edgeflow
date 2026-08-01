import { isRetryableStatus, NonRetryableError } from '../errors';
import { requireParam, type NodeImpl, type NodeResult } from './types';

export type HttpOutput = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export const httpNode: NodeImpl = async (ctx): Promise<NodeResult> => {
  const url = String(requireParam(ctx, 'url'));
  const method = String(ctx.params.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(ctx.params.headers as Record<string, string> ?? {}) };

  let body: string | undefined;
  if (ctx.params.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = typeof ctx.params.body === 'string'
      ? ctx.params.body
      : JSON.stringify(ctx.params.body);
    headers['content-type'] ??= 'application/json';
  }

  const res = await fetch(url, { method, headers, body });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const message = `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`;
    // 4xx（429 を除く）は投げ直しても結果が変わらないためリトライしない。
    if (!isRetryableStatus(res.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }

  return { output: await toOutput(res) };
};

async function toOutput(res: Response): Promise<HttpOutput> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await res.json() : await res.text();
  return { status: res.status, headers, body };
}
