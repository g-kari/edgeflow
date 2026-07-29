# 単一 Worker で完結させる — 式インタプリタ

実施日 2026-07-30 / `n8n-workflow@2.16.0` + `@n8n/tournament@1.8.1` + `esprima-next@5.8.4` / `wrangler 4.115.0`

**結論: 完結します。Worker Loader も動的 Worker も不要でした。**

これが `experiments/engine-in-dynamic-worker/`（Phase 1）に対する**より単純で、より安全な代替案**です。**こちらを採用します。**

## なぜこうしたか

動的 Worker が必要だった理由は**ただ一つ、`new Function` が Workers で禁止されていること**でした。それ以外は単一 Worker で足ります。

ならば「コード生成をしない」で式を評価できれば、動的 Worker ごと不要になります。`@n8n/tournament` の `getExpressionCode()` が返すのは JS のソース文字列なので、**それを `new Function` に渡す代わりに `esprima-next` で AST 化し、ツリーウォークで直接解釈**すればよい、という発想です。

```
tournament.getExpressionCode(expr)   ← AST 変換のみ。eval なし
        ↓  JS ソース文字列
esprima.parseScript(...)             ← AST 化。eval なし
        ↓  AST
interpreter.run(ast, data, E)        ← ツリーウォーク。完全に同期
```

**`new Function` も `eval` も一度も使いません。**

## 動的 Worker 方式との比較

| | 動的 Worker 方式 | **単一 Worker 方式（採用）** |
|---|---|---|
| gzip サイズ | 582.80 KiB（エンジン）+ 外側 Worker | **627.92 KiB（全部込み）** |
| Worker Loader | **必須** | 不要 |
| 本番での動作確認 | **未確認（最大のリスク）** | 通常の Worker なので確実 |
| 非同期境界 | 動的 Worker 生成の 1 回 | **なし** |
| モジュール転送 | 毎回 3.45MB を Worker Loader へ | なし |
| 式評価 | テーブル参照（同期） | インタプリタ（同期） |
| 実装量 | 少ない | インタプリタ約 260 行 |

**決め手は「本番での動作確認」**です。Worker Loader はローカル workerd でしか検証できておらず、以前 `unsafe_eval` バインディングがローカルで使えなかった前例があります。単一 Worker 方式なら**通常の Worker として動く**ため、このリスクが丸ごと消えます。

## 手順

```bash
npm install
npm test          # Node 側で 17 式を検証
npm run size      # バンドルサイズ計測
npm run dev       # workerd 上で検証
```

## 検証結果

**Node 側（`test-node.mjs`）: 17 式すべて期待どおり**

| 式 | 結果 |
|---|---|
| `{{ 1 + 2 }}` | `3` |
| `{{ $json.name }}` | `"gizen"` |
| `Hello {{ $json.name }}, you are {{ $json.age * 2 }}` | `"Hello gizen, you are 42"` |
| `{{ [1,2,3].map(x => x * 2).join("-") }}` | `"2-4-6"` |
| `{{ $json.items.filter(i => i.ok).length }}` | `2` |
| `{{ $json.age > 18 ? "adult" : "minor" }}` | `"adult"` |
| `{{ ({a:1, b:$json.n}).b }}` | `7` |
| `{{ $json.name.toUpperCase().split("").reverse().join("") }}` | `"NEZIG"` |
| `{{ [1,2,3].reduce((a,b) => a+b, 0) }}` | `6` |
| `{{ $json.missing?.deep ?? "fallback" }}` | `"fallback"` |
| `` {{ `tpl ${$json.n + 1}` }} `` | `"tpl 8"` |
| `{{ $json.constructor.constructor("return 1")() }}` | **遮断** |
| `{{ ({}).__proto__ }}` | **遮断** |

**workerd 側（`result.json`）: n8n 本体のサンドボックス込みで一致**

`ThisSanitizer` / `PrototypeSanitizer` / `DollarSignValidator` を通した状態で、`new Workflow()` によるパラメータ正規化も経て解決できています。バンドルは **gzip 627.92 KiB**。

## ★ `filter(Boolean)` は「バグではなく忠実さ」

workerd 側で `{{ $json.items.map(i => i.ok).filter(Boolean).length }}` が `undefined is not a function` になります。これは**実際の n8n と同じ挙動**です。

n8n の `ThisSanitizer` は識別子をこう書き換えます。

```js
var global = {};
return [1,2].filter(("Boolean" in this ? this : global).Boolean).length;
```

`global` は空オブジェクトなので、`this`（＝データ）に `Boolean` が無ければ `undefined` になります。実際に `new Function` で同じコードを実行しても `undefined` が返ることを確認済みです。

つまり **n8n の式から素の JS グローバルには触れません**。式で使える `$now` / `$today` / `DateTime` などは、n8n がデータオブジェクト側に注入しているものです。インタプリタはこの意味論を正しく再現しています。

なおインタプリタ自身も `SAFE_GLOBALS` という allowlist しか公開しておらず、**`globalThis` を晒さない**ため Worker のバインディングや `fetch` には到達できません。

## セキュリティ

三重に防いでいます。

1. **tournament の AST フック** — n8n 本体と同一（`PrototypeSanitizer` 等）がコンパイル段階で拒否
2. **インタプリタの `BLOCKED_KEYS`** — `__proto__` / `constructor` / `prototype` / `__defineGetter__` / `__defineSetter__` へのアクセスを実行時に遮断
3. **`SAFE_GLOBALS` の allowlist** — `Boolean` `Math` `JSON` 等のみ。`globalThis` も `fetch` も見えない

そもそも**インタプリタは自分が解釈できるノード型しか実行しません**。未知の構文は `unsupported expression node: X` で落ちるため、既定が拒否側に倒れています。

## 対応している AST ノード

式: `Literal` `Identifier` `ThisExpression` `ChainExpression` `MemberExpression` `CallExpression` `ArrowFunctionExpression` `FunctionExpression` `BinaryExpression` `LogicalExpression` `UnaryExpression` `ConditionalExpression` `ArrayExpression` `ObjectExpression` `TemplateLiteral` `SequenceExpression` `AssignmentExpression`

文: `BlockStatement` `VariableDeclaration` `ExpressionStatement` `ReturnStatement` `IfStatement` `TryStatement` `EmptyStatement`

パターン: `Identifier` `ArrayPattern` `ObjectPattern` `AssignmentPattern`

オプショナルチェーン（`?.`）、スプレッド（`...`）、分割代入に対応。

## 未対応・今後

- **ループ構文**（`for` / `while`）とクラス定義。式では通常使いませんが、**Code ノード**を実装するなら必要になります。そこだけは Worker Loader を使う手もあります
- 式拡張関数（`.toSnakeCase()` 等、`@n8n/expression-runtime` の extensions）の組み込み
- `$now` / `$today`（Luxon）。Workers のタイマーは「最後の I/O 時点」で止まる仕様との相互作用に注意
- 実行性能の測定。式は小さいのでインタプリタでも問題ないはずですが未計測
