import { Tournament } from '@n8n/tournament';
// n8n 本体と同一のサンドボックス AST フックを使う
import { ThisSanitizer, PrototypeSanitizer, DollarSignValidator }
  from 'n8n-workflow/dist/esm/expression-sandboxing.js';

// 式文字列 → コンパイル済み関数ソース。eval は一切使わない（AST 変換のみ）。
function compileTable(exprs) {
  const t = new Tournament(() => {}, undefined, undefined, {
    before: [ThisSanitizer],
    after: [PrototypeSanitizer, DollarSignValidator],
  });
  const entries = [], rejected = {};
  for (const e of exprs) {
    try {
      const [code] = t.getExpressionCode(e);          // AST 変換のみ。eval なし
      entries.push(`  ${JSON.stringify(e)}: function (E) {\n${code}\n  }`);
    } catch (err) {
      // サンドボックスが危険な式をコンパイル時点で拒否する
      rejected[e] = String(err && err.message || err);
    }
  }
  return { source: `export const TABLE = {\n${entries.join(',\n')}\n};\n`, rejected };
}

// 動的 Worker のモジュールソース。式はモジュールのトップレベルで関数として
// 定義されるため、内部では new Function も eval も一切不要になる。
function buildModule(exprs) {
  const { source, rejected } = compileTable(exprs);
  return { rejected, source: source + `
export default {
  async fetch(req) {
    const { expr, data } = await req.json();
    const fn = TABLE[expr];
    if (!fn) return Response.json({ error: 'not compiled' }, { status: 400 });
    const errors = [];
    const E = (e) => { errors.push(String(e && e.message || e)); };
    try {
      const out = fn.call(data, E);          // ← 完全に同期
      return Response.json({ ok: true, value: out, errors });
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.message || e) });
    }
  }
};
` };
}

const EXPRS = [
  '{{ 1 + 2 }}',
  '{{ $json.name }}',
  'Hello {{ $json.name }}, you are {{ $json.age * 2 }}',
  '{{ [1,2,3].map(x => x * 2).join("-") }}',
  '{{ $json.items.filter(i => i.ok).length }}',
  // --- サンドボックスが遮断すべき式 ---
  '{{ $json.constructor.constructor("return 1+1")() }}',
  '{{ ({}).__proto__ }}',
];

export default {
  async fetch(req, env) {
    const out = { hasLoader: !!env.LOADER };
    try {
      const { source, rejected } = buildModule(EXPRS);
      out.moduleBytes = source.length;
      out.rejectedBySandbox = rejected;

      // 動的 Worker を 1 回だけ生成（ここだけが非同期）
      const w = await env.LOADER.get('expr-table-v1', async () => ({
        compatibilityDate: '2025-09-15',
        mainModule: 'main.js',
        modules: { 'main.js': source },
        globalOutbound: null,          // egress 完全遮断
      }));
      const ep = w.getEntrypoint();

      const data = { $json: { name: 'gizen', age: 21, items: [{ ok: true }, { ok: false }, { ok: true }] } };
      out.results = {};
      for (const expr of EXPRS) {
        if (rejected[expr]) { out.results[expr] = { blocked: rejected[expr] }; continue; }
        const resp = await ep.fetch('http://x/', {
          method: 'POST',
          body: JSON.stringify({ expr, data }),
        });
        out.results[expr] = await resp.json();
      }
    } catch (e) {
      out.error = String(e && e.message || e);
      out.stack = String(e && e.stack || '').split('\n').slice(0, 5);
    }
    return new Response(JSON.stringify(out, null, 1));
  }
};
