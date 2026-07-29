// 単一 Worker で完結する構成。Worker Loader も動的 Worker も使わない。
import { Workflow } from 'n8n-workflow';
import { Tournament } from '@n8n/tournament';
import { ThisSanitizer, PrototypeSanitizer, DollarSignValidator }
  from 'n8n-workflow/dist/esm/expression-sandboxing.js';
import { compile, run } from './interpreter.js';

const tournament = new Tournament(() => {}, undefined, undefined, {
  before: [ThisSanitizer], after: [PrototypeSanitizer, DollarSignValidator],
});

const cache = new Map();
function evaluateExpression(expr, data) {
  let compiled = cache.get(expr);
  if (!compiled) {
    const [code] = tournament.getExpressionCode(expr);   // AST 変換のみ
    compiled = compile(code);                            // esprima で AST 化
    cache.set(expr, compiled);
  }
  const errors = [];
  const value = run(compiled, data, (e) => errors.push(String(e?.message || e)));
  return { value, errors };
}

const WF = {
  id: 'w1', name: 'demo', active: false, connections: {},
  nodes: [{
    id: 'a', name: 'Set', type: 'test.set', typeVersion: 1, position: [0, 0],
    parameters: {
      greeting: '={{ "hello " + $json.who }}',
      doubled:  '={{ $json.n * 2 }}',
      listed:   '={{ [1,2,3].map(x => x + $json.n).join("|") }}',
      chained:  '={{ $json.missing?.deep ?? "fallback" }}',
      filtered: '={{ $json.items.map(i => i.ok).filter(Boolean).length }}',
      evil:     '={{ $json.constructor.constructor("return 1")() }}',
    },
  }],
};

const nodeTypes = {
  getByName: () => undefined,
  getByNameAndVersion: () => ({ description: {
    name: 'test.set', displayName: 'Set', version: 1, group: ['transform'],
    defaults: {}, inputs: ['main'], outputs: ['main'],
    properties: Object.keys(WF.nodes[0].parameters).map((name) => (
      { displayName: name, name, type: 'string', default: '' })),
  } }),
  getKnownTypes: () => ({}),
};

export default {
  async fetch() {
    const out = { mode: 'single-worker (no Worker Loader)' };
    try {
      const workflow = new Workflow({ ...WF, nodeTypes });
      out.nodeNames = Object.keys(workflow.nodes);
      const data = { $json: { who: 'gizen', n: 7, items: [{ ok: true }, { ok: false }, { ok: true }] } };
      out.resolved = {};
      for (const [k, v] of Object.entries(workflow.nodes.Set.parameters)) {
        try { out.resolved[k] = evaluateExpression(String(v).slice(1), data); }
        catch (e) { out.resolved[k] = { blocked: String(e?.message || e) }; }
      }
    } catch (e) {
      out.error = String(e?.message || e);
      out.stack = String(e?.stack || '').split('\n').slice(0, 5);
    }
    return new Response(JSON.stringify(out, null, 1));
  }
};
