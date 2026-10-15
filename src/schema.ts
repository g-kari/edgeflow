import { z } from 'zod';

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

export type Literal =
  | string | number | boolean | null
  | Literal[]
  | { [k: string]: Literal };

const literalSchema: z.ZodType<Literal> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(literalSchema),
    z.record(literalSchema),
  ]),
);

export type ParamValue = Literal | { $expr: string };

const paramValueSchema: z.ZodType<ParamValue> = z.union([
  z.object({ $expr: z.string() }).strict(),
  literalSchema,
]);

export const NODE_TYPES = ['http', 'transform', 'if', 'notify'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  name: z.string().min(1),
  params: z.record(paramValueSchema),
  retry: z.object({ limit: z.number().int().min(0).max(10) }).optional(),
});

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  branch: z.enum(['true', 'false']).optional(),
});

export const workflowSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  trigger: z.union([
    z.object({ type: z.literal('cron'), cron: z.string().min(1) }),
    z.object({ type: z.literal('manual') }),
  ]),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema),
  defaultRetryLimit: z.number().int().min(0).max(10).optional(),
});

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type Edge = z.infer<typeof edgeSchema>;

export function parseWorkflow(input: unknown): Workflow {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    throw new SchemaError(`定義の形式が不正です: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  const wf = parsed.data;
  validateGraph(wf);
  return wf;
}

function validateGraph(wf: Workflow): void {
  const byId = new Map<string, WorkflowNode>();
  for (const n of wf.nodes) {
    if (byId.has(n.id)) throw new SchemaError(`Node の id が重複しています: ${n.id}`);
    byId.set(n.id, n);
  }

  const names = new Set<string>();
  for (const n of wf.nodes) {
    if (names.has(n.name)) throw new SchemaError(`Node の name が重複しています: ${n.name}`);
    names.add(n.name);
  }

  for (const e of wf.edges) {
    if (!byId.has(e.from)) throw new SchemaError(`存在しないノードを参照しています: ${e.from}`);
    if (!byId.has(e.to)) throw new SchemaError(`存在しないノードを参照しています: ${e.to}`);
    if (e.branch && byId.get(e.from)!.type !== 'if') {
      throw new SchemaError(`branch は if ノードの出力辺にのみ指定できます: ${e.from}`);
    }
  }

  const inbound = new Map<string, number>(wf.nodes.map((n) => [n.id, 0]));
  for (const e of wf.edges) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
  const outbound = new Map<string, number>(wf.nodes.map((n) => [n.id, 0]));
  for (const e of wf.edges) outbound.set(e.from, (outbound.get(e.from) ?? 0) + 1);

  // 入次数 0 の孤立ノード（出次数も 0）は「到達不能」として扱うため、
  // ノードが 1 個だけの自明なワークフローを除きエントリ候補から除外する。
  const entries = wf.nodes.filter((n) => {
    if ((inbound.get(n.id) ?? 0) !== 0) return false;
    if (wf.nodes.length === 1) return true;
    return (outbound.get(n.id) ?? 0) > 0;
  });
  if (entries.length !== 1) {
    throw new SchemaError(`エントリノードはちょうど 1 つ必要です（現在 ${entries.length} 個）`);
  }

  detectCycle(wf, byId);
  detectUnreachable(wf, entries[0]!.id, byId);
}

function detectCycle(wf: Workflow, byId: Map<string, WorkflowNode>): void {
  const out = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) out.get(e.from)!.push(e.to);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(wf.nodes.map((n) => [n.id, WHITE]));

  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const next of out.get(id) ?? []) {
      const c = color.get(next);
      if (c === GRAY) throw new SchemaError(`グラフに循環があります: ${id} → ${next}`);
      if (c === WHITE) visit(next);
    }
    color.set(id, BLACK);
  };

  for (const n of byId.keys()) if (color.get(n) === WHITE) visit(n);
}

function detectUnreachable(wf: Workflow, entryId: string, byId: Map<string, WorkflowNode>): void {
  const out = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) out.get(e.from)!.push(e.to);

  const seen = new Set<string>([entryId]);
  const stack = [entryId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of out.get(id) ?? []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }

  for (const id of byId.keys()) {
    if (!seen.has(id)) throw new SchemaError(`到達不能なノードがあります: ${id}`);
  }
}
