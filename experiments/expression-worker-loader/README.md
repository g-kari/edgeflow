# PoC-2: n8n の式評価を Cloudflare Workers 上で動かす

実施日 2026-07-29 / `@n8n/tournament@1.8.1` + `n8n-workflow@2.16.0` / `wrangler 4.115.0` / `compatibility_date: 2025-09-15`

**結論: 成功。Track B（Workers ネイティブ）の最大の技術的不確実性が解消されました。**

`experiments/workerd-n8n-workflow/` で判明した「`new Function` が Workers のランタイムポリシーで禁止されている」という壁を、**コード生成と実行を分離する**ことで越えました。しかも n8n 本体と同一のサンドボックスがそのまま機能します。

## 手順

```bash
npm install
npx wrangler dev
curl http://127.0.0.1:8787/
```

実行結果は `result.json` に保存してあります。

## 設計 — なぜ eval が要らなくなるのか

`@n8n/tournament` の `FunctionEvaluator` は 20 行しかなく、eval を使うのは 1 箇所だけです。

```js
getFunction(expr) {
    const [code] = this.instance.getExpressionCode(expr);
    const func = new Function('E', code + ';');   // ← ここだけ
    ...
}
```

重要なのは **`getExpressionCode()` が AST 変換のみで eval を一切使わない**点です。返るのは「関数本体のソース文字列」で、たとえば `{{ 1 + 2 }}` からは次が生成されます。

```js
var global = {};
return 1 + 2;
```

つまり `new Function('E', code)` は **文字列を関数にする最後の一手**でしかありません。ここを次のように分解します。

1. **コンパイル段階（同期・eval 不要）** — ワークフロー内の全式に `getExpressionCode()` をかけ、ソース文字列を集める
2. **ロード段階（非同期・1 回だけ）** — 集めたソースを**モジュールのトップレベル関数**として埋め込んだモジュールを生成し、Worker Loader で動的 Worker を作る
3. **実行段階（同期）** — 動的 Worker 内ではルックアップテーブルを引くだけ。**`new Function` も `eval` も登場しない**

生成されるモジュールはこの形です。

```js
export const TABLE = {
  "{{ 1 + 2 }}": function (E) {
    var global = {};
    return 1 + 2;
  },
  ...
};
export default { async fetch(req) { /* TABLE[expr].call(data, E) */ } };
```

**「非同期になるのはロード段階だけで、式評価そのものは同期のまま」**というのがこの設計の要点です。`Tournament.execute()` は評価器に委譲するだけなので、同期インタフェースを崩さずに済みます。

## 検証結果

5 式すべてが正しく評価されました。文字列補間、アロー関数、配列メソッド、`$json` へのアクセスがいずれも動作しています。

| 式 | 結果 |
|---|---|
| `{{ 1 + 2 }}` | `3` |
| `{{ $json.name }}` | `"gizen"` |
| `Hello {{ $json.name }}, you are {{ $json.age * 2 }}` | `"Hello gizen, you are 42"` |
| `{{ [1,2,3].map(x => x * 2).join("-") }}` | `"2-4-6"` |
| `{{ $json.items.filter(i => i.ok).length }}` | `2` |

5 式ぶんの生成モジュールは **1,738 bytes**。

## サンドボックスも機能する

n8n 本体と同一の AST フック（`ThisSanitizer` / `PrototypeSanitizer` / `DollarSignValidator`）を渡して検証しました。

```js
new Tournament(() => {}, undefined, undefined, {
  before: [ThisSanitizer],
  after: [PrototypeSanitizer, DollarSignValidator],
});
```

危険な式は **コンパイル段階で拒否**され、コードが生成される前に止まります。

| 攻撃的な式 | 遮断メッセージ |
|---|---|
| `{{ $json.constructor.constructor("return 1+1")() }}` | `Cannot access "constructor" due to security concerns` |
| `{{ ({}).__proto__ }}` | `Cannot access "__proto__" due to security concerns` |

**実行時ではなくコンパイル時に落ちる**ため、n8n 本体より前段で防げていることになります。加えて動的 Worker 側で `globalOutbound: null` を指定しているので、**式から外部への通信が原理的に不可能**です。n8n 本来の external task runner より強いサンドボックスが、追加実装なしで手に入ります。

## ハマりどころ — esbuild で事前バンドルしてはいけない

最初に esbuild で事前バンドルしたところ、起動時にこれで落ちました。

```
Uncaught Error: Dynamic require of "fs" is not supported
  at node_modules/recast/main.js
  at node_modules/@n8n/tournament/dist/ExpressionBuilder.js
```

`fs` をスタブ化すると次は `assert` で同じ失敗になります。原因は **Node 組み込みを `external` にすると、ネストした `require()` が esbuild の `__require` シムに落ちて必ず throw する**ことです（`PLAN.md` §3.6 の動的 require 問題）。

**解決策は「esbuild を挟まず wrangler に直接バンドルさせる」**ことでした。

```jsonc
{ "main": "src.js", "compatibility_flags": ["nodejs_compat"] }
```

wrangler 内蔵のバンドラは `nodejs_compat` の組み込みモジュール解決を正しく行います。**本プロジェクトでは事前バンドルを避け、wrangler にビルドさせる方針を既定とすべきです。**

## 次に検証すべきこと

- **式拡張関数**（`.toSnakeCase()` 等、`@n8n/expression-runtime` の extensions）が動的 Worker 内で使えるか。現状の PoC は拡張なしの素の式のみ
- `$now` / `$today`（Luxon 依存）の挙動。Workers のタイマーは「最後の I/O 時点」で止まる仕様なので要注意
- 動的 Worker の**生成コストとキャッシュ戦略**。`env.LOADER.get(id, ...)` の id をワークフロー ID + 版数にすれば使い回せるはず
- ワークフロー全体の実行を動的 Worker の中に入れてしまう案（非同期境界を 1 回に減らせる）
