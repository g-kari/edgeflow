import type { Edge, Workflow, WorkflowNode } from './schema';

export type StepOutcome = { branch?: 'true' | 'false' };

export class ExecutionPlanner {
  private readonly byId = new Map<string, WorkflowNode>();
  private readonly outEdges = new Map<string, Edge[]>();
  private readonly inEdgeCount = new Map<string, number>();
  private readonly activatedInbound = new Map<string, number>();
  private readonly executed = new Set<string>();
  private readonly ready: string[] = [];

  constructor(private readonly wf: Workflow) {
    for (const node of wf.nodes) {
      this.byId.set(node.id, node);
      this.outEdges.set(node.id, []);
      this.inEdgeCount.set(node.id, 0);
      this.activatedInbound.set(node.id, 0);
    }
    for (const e of wf.edges) {
      this.outEdges.get(e.from)!.push(e);
      this.inEdgeCount.set(e.to, this.inEdgeCount.get(e.to)! + 1);
    }
    for (const node of wf.nodes) {
      if (this.inEdgeCount.get(node.id) === 0) this.ready.push(node.id);
    }
  }

  next(): WorkflowNode | null {
    const id = this.ready.shift();
    if (id === undefined) return null;
    return this.byId.get(id)!;
  }

  complete(nodeId: string, outcome: StepOutcome): void {
    this.executed.add(nodeId);
    const node = this.byId.get(nodeId)!;
    for (const e of this.outEdges.get(nodeId)!) {
      // if ノードは結果に一致する辺だけを活性化する。
      // 一致する辺が無ければその経路はここで正常終了する。
      if (node.type === 'if' && e.branch !== outcome.branch) continue;
      this.activate(e.to);
    }
  }

  // 入力辺が 1 本でも活性化されたら実行対象にする（最大 1 回）。
  private activate(nodeId: string): void {
    const count = this.activatedInbound.get(nodeId)! + 1;
    this.activatedInbound.set(nodeId, count);
    if (count === 1 && !this.executed.has(nodeId) && !this.ready.includes(nodeId)) {
      this.ready.push(nodeId);
    }
  }

  skipped(): string[] {
    return this.wf.nodes.filter((n) => !this.executed.has(n.id)).map((n) => n.id);
  }
}
