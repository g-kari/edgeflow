import { Tournament } from '@n8n/tournament';
import { ThisSanitizer, PrototypeSanitizer, DollarSignValidator }
  from 'n8n-workflow/dist/esm/expression-sandboxing.js';
import ENGINE_BUNDLE from './engine-bundle.txt';

// ワークフロー JSON から式を集める
function collectExpressions(wf) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (v.startsWith('=')) found.add(v.slice(1)); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  wf.nodes.forEach((n) => walk(n.parameters));
  return [...found];
}

// 式 → コンパイル済み関数ソース（AST 変換のみ。eval なし）
function compileTable(exprs) {
  const t = new Tournament(() => {}, undefined, undefined, {
    before: [ThisSanitizer], after: [PrototypeSanitizer, DollarSignValidator],
  });
  const entries = [], rejected = {};
  for (const e of exprs) {
    try {
      const [code] = t.getExpressionCode(e);
      entries.push(`  ${JSON.stringify(e)}: function (E) {\n${code}\n  }`);
    } catch (err) { rejected[e] = String(err && err.message || err); }
  }
  return { rejected, source: `export const TABLE = {\n${entries.join(',\n')}\n};\n` };
}

export default {
  async fetch(req, env) {
    const out = { engineBytes: ENGINE_BUNDLE.length };
    const WF = {
      id: 'w1', name: 'demo', active: false, connections: {},
      nodes: [{
        id: 'a', name: 'Set', type: 'test.set', typeVersion: 1, position: [0, 0],
        parameters: {
          greeting: '={{ "hello " + $json.who }}',
          doubled:  '={{ $json.n * 2 }}',
          listed:   '={{ [1,2,3].map(x => x + $json.n).join("|") }}',
        },
      }],
    };
    try {
      const exprs = collectExpressions(WF);
      out.collected = exprs;
      const { source: tableSrc, rejected } = compileTable(exprs);
      out.rejected = rejected;

      // main.js はエンジンを import してテーブルを登録するだけの薄い層
      const mainSrc = tableSrc + `
import './engine.js';
const { Workflow, registerExpressionTable, evaluateExpression } = globalThis.__CFN8N__;
registerExpressionTable(TABLE);
export default {
  async fetch(req) {
    const { wf, data } = await req.json();
    const nodeTypes = {
      getByName: () => undefined,
      getByNameAndVersion: () => ({ description: {
        name: 'test.set', displayName: 'Set', version: 1, group: ['transform'],
        defaults: {}, inputs: ['main'], outputs: ['main'],
        // n8n は description に宣言のないパラメータを正規化で削除するため、必ず宣言する
        properties: [
          { displayName: 'Greeting', name: 'greeting', type: 'string', default: '' },
          { displayName: 'Doubled',  name: 'doubled',  type: 'string', default: '' },
          { displayName: 'Listed',   name: 'listed',   type: 'string', default: '' },
        ] } }),
      getKnownTypes: () => ({}),
    };
    const workflow = new Workflow({ ...wf, nodeTypes });
    const resolved = {};
    const params = workflow.nodes['Set'].parameters || {};
    const diag = { paramKeys: Object.keys(params), tableKeys: Object.keys(TABLE) };
    for (const k of Object.keys(params)) {
      const v = params[k];
      try { resolved[k] = evaluateExpression(String(v).slice(1), data); }
      catch (err) { resolved[k] = { error: String(err && err.message || err) }; }
    }
    return Response.json({
      workflowConstructed: true,
      nodeNames: Object.keys(workflow.nodes),
      diag, resolved,
    });
  }
};`;

      const w = await env.LOADER.get('wf-w1-v1', async () => ({
        compatibilityDate: '2025-09-15',
        compatibilityFlags: ['nodejs_compat'],
        mainModule: 'main.js',
        modules: { 'main.js': mainSrc, 'engine.js': ENGINE_BUNDLE },
        globalOutbound: null,
      }));
      const resp = await w.getEntrypoint().fetch('http://x/', {
        method: 'POST',
        body: JSON.stringify({ wf: WF, data: { $json: { who: 'gizen', n: 7 } } }),
      });
      out.engine = await resp.json();
    } catch (e) {
      out.error = String(e && e.message || e);
      out.stack = String(e && e.stack || '').split('\n').slice(0, 5);
    }
    return new Response(JSON.stringify(out, null, 1));
  }
};
