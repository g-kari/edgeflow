import { Tournament } from '@n8n/tournament';
// (Node 側テストでは n8n の AST フックを外す。インタプリタ自身の BLOCKED_KEYS で防御を確認)
import { compile, run } from './interpreter.js';

const t = new Tournament();

const data = { $json: { who: 'gizen', name: 'gizen', age: 21, n: 7,
                        items: [{ ok: true }, { ok: false }, { ok: true }] } };

const CASES = [
  '{{ 1 + 2 }}',
  '{{ $json.name }}',
  'Hello {{ $json.name }}, you are {{ $json.age * 2 }}',
  '{{ [1,2,3].map(x => x * 2).join("-") }}',
  '{{ $json.items.filter(i => i.ok).length }}',
  '{{ "hello " + $json.who }}',
  '{{ $json.n * 2 }}',
  '{{ [1,2,3].map(x => x + $json.n).join("|") }}',
  '{{ $json.age > 18 ? "adult" : "minor" }}',
  '{{ ({a:1, b:$json.n}).b }}',
  '{{ $json.items.map(i => i.ok).filter(Boolean).length }}',
  '{{ $json.name.toUpperCase().split("").reverse().join("") }}',
  '{{ [1,2,3].reduce((a,b) => a+b, 0) }}',
  '{{ $json.missing?.deep ?? "fallback" }}',
  '{{ `tpl ${$json.n + 1}` }}',
  // サンドボックスが遮断すべきもの
  '{{ $json.constructor.constructor("return 1")() }}',
  '{{ ({}).__proto__ }}',
];

let pass = 0, fail = 0, blocked = 0;
for (const expr of CASES) {
  const inner = expr.startsWith('{{') ? expr : expr;
  try {
    const [code] = t.getExpressionCode(inner);
    const compiled = compile(code);
    const errors = [];
    const v = run(compiled, data, (e) => errors.push(String(e?.message || e)));
    console.log(`✓ ${expr}\n    → ${JSON.stringify(v)}${errors.length ? '  errors=' + JSON.stringify(errors) : ''}`);
    pass++;
  } catch (e) {
    if (/security concerns/.test(e.message)) { console.log(`🛡 ${expr}\n    → 遮断: ${e.message}`); blocked++; }
    else { console.log(`✗ ${expr}\n    → ${e.message}`); fail++; }
  }
}
console.log(`\n成功 ${pass} / 遮断 ${blocked} / 失敗 ${fail}`);
