import { describe, expect, it } from 'vitest';
import { ExecutionPlanner } from '../src/graph';
import { parseWorkflow, type Workflow } from '../src/schema';

const wf = (nodes: any[], edges: any[]): Workflow =>
  parseWorkflow({
    schemaVersion: 1, id: 'w', name: 'w',
    trigger: { type: 'manual' }, nodes, edges,
  });

const n = (id: string, type = 'transform') => ({ id, type, name: id.toUpperCase(), params: {} });

const runAll = (w: Workflow, outcomes: Record<string, 'true' | 'false'> = {}) => {
  const p = new ExecutionPlanner(w);
  const order: string[] = [];
  let node = p.next();
  while (node) {
    order.push(node.id);
    p.complete(node.id, { branch: outcomes[node.id] });
    node = p.next();
  }
  return { order, skipped: p.skipped() };
};

describe('ExecutionPlanner', () => {
  it('一直線のグラフを順に返す', () => {
    const w = wf([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    expect(runAll(w).order).toEqual(['a', 'b', 'c']);
  });

  it('分岐で true 側だけ通る', () => {
    const w = wf(
      [n('a', 'if'), n('t'), n('f')],
      [{ from: 'a', to: 't', branch: 'true' }, { from: 'a', to: 'f', branch: 'false' }],
    );
    const r = runAll(w, { a: 'true' });
    expect(r.order).toEqual(['a', 't']);
    expect(r.skipped).toEqual(['f']);
  });

  it('選ばれなかった側の下流もスキップになる', () => {
    const w = wf(
      [n('a', 'if'), n('t'), n('f'), n('f2')],
      [
        { from: 'a', to: 't', branch: 'true' },
        { from: 'a', to: 'f', branch: 'false' },
        { from: 'f', to: 'f2' },
      ],
    );
    const r = runAll(w, { a: 'true' });
    expect(r.order).toEqual(['a', 't']);
    expect(r.skipped.sort()).toEqual(['f', 'f2']);
  });

  it('対応する branch の辺が無ければ正常終了する', () => {
    const w = wf([n('a', 'if'), n('t')], [{ from: 'a', to: 't', branch: 'true' }]);
    const r = runAll(w, { a: 'false' });
    expect(r.order).toEqual(['a']);
    expect(r.skipped).toEqual(['t']);
  });

  it('合流したノードは 1 回だけ実行される', () => {
    const w = wf(
      [n('a', 'if'), n('t'), n('f'), n('m')],
      [
        { from: 'a', to: 't', branch: 'true' },
        { from: 'a', to: 'f', branch: 'false' },
        { from: 't', to: 'm' },
        { from: 'f', to: 'm' },
      ],
    );
    const r = runAll(w, { a: 'true' });
    expect(r.order).toEqual(['a', 't', 'm']);
    expect(r.skipped).toEqual(['f']);
  });

  it('走査完了後は next() が null を返す', () => {
    const w = wf([n('a')], []);
    const p = new ExecutionPlanner(w);
    expect(p.next()!.id).toBe('a');
    p.complete('a', {});
    expect(p.next()).toBeNull();
  });
});
