import { describe, expect, it } from 'vitest';
import { parseWorkflow, SchemaError } from '../src/schema';

const base = (): any => ({
  schemaVersion: 1,
  id: 'wf-1',
  name: 'demo',
  trigger: { type: 'cron', cron: '0 9 * * *' },
  nodes: [
    { id: 'a', type: 'http', name: 'Fetch', params: { url: 'https://example.com' } },
    { id: 'b', type: 'transform', name: 'Pick', params: { value: { $expr: '{{ $json.body }}' } } },
  ],
  edges: [{ from: 'a', to: 'b' }],
});

describe('parseWorkflow', () => {
  it('正しい定義を通す', () => {
    const wf = parseWorkflow(base());
    expect(wf.name).toBe('demo');
    expect(wf.nodes).toHaveLength(2);
  });

  it('schemaVersion が 1 でなければ拒否する', () => {
    expect(() => parseWorkflow({ ...base(), schemaVersion: 2 })).toThrow(SchemaError);
  });

  it('エントリノードが 0 個なら拒否する', () => {
    const wf = base();
    wf.edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }];
    expect(() => parseWorkflow(wf)).toThrow(/エントリノード/);
  });

  it('エントリノードが 2 個なら拒否する', () => {
    const wf = base();
    wf.edges = [];
    expect(() => parseWorkflow(wf)).toThrow(/エントリノード/);
  });

  it('存在しない from を拒否する', () => {
    const wf = base();
    wf.edges = [{ from: 'zzz', to: 'b' }];
    expect(() => parseWorkflow(wf)).toThrow(/存在しないノード/);
  });

  it('循環を拒否する', () => {
    const wf = base();
    wf.nodes.push({ id: 'c', type: 'transform', name: 'C', params: {} });
    wf.edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }];
    expect(() => parseWorkflow(wf)).toThrow(/循環/);
  });

  it('到達不能ノードを拒否する', () => {
    const wf = base();
    wf.nodes.push({ id: 'c', type: 'transform', name: 'Orphan', params: {} });
    expect(() => parseWorkflow(wf)).toThrow(/到達不能/);
  });

  it('if 以外への branch を拒否する', () => {
    const wf = base();
    wf.edges = [{ from: 'a', to: 'b', branch: 'true' }];
    expect(() => parseWorkflow(wf)).toThrow(/branch/);
  });

  it('重複した Node.name を拒否する', () => {
    const wf = base();
    wf.nodes[1]!.name = 'Fetch';
    expect(() => parseWorkflow(wf)).toThrow(/name が重複/);
  });

  it('重複した Node.id を拒否する', () => {
    const wf = base();
    wf.nodes[1]!.id = 'a';
    expect(() => parseWorkflow(wf)).toThrow(/id が重複/);
  });

  it('$expr パラメータを受け付ける', () => {
    const wf = parseWorkflow(base());
    expect(wf.nodes[1]!.params.value).toEqual({ $expr: '{{ $json.body }}' });
  });
});
