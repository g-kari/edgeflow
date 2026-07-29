# 実験: `n8n-workflow` を workerd（Cloudflare Workers ランタイム）で動かす

実施日 2026-07-29 / `n8n-workflow@2.16.0` / `wrangler 4.115.0` / `compatibility_date: 2025-09-01` / `compatibility_flags: ["nodejs_compat"]`

`PLAN.md` の方針判断の根拠となった実測です。**結論だけ先に言うと、バンドルもロードも `new Workflow()` の構築も成功し、唯一詰まるのは式評価の `new Function` です。**

## 手順

```bash
npm install
node build.mjs                      # → out.js
gzip -c out.js | wc -c              # → 570053
npx wrangler dev                    # wrangler.jsonc の main を entry*.js で差し替えて実行
```

## エントリポイントの対応表

| ファイル | 目的 | 結果 |
|---|---|---|
| `entry.js` | バンドル対象のエントリ（`build.mjs` が読む） | — |
| `entry2.js` | workerd 上で `n8n-workflow` の export が解決できるか | ✅ `{"Workflow":"function","jsonParse":"function","main":"main","NodeHelpers":"object"}` |
| `entry3.js` | `new Workflow()` 構築 + 式評価 | ✅ 構築成功 / ❌ 式評価は `EvalError` |
| `entry4.js` | 式エンジンの実装判定 | `Expression.getActiveImplementation()` → `"legacy"` |
| `entry5.js` | `unsafe_eval` バインディングで `new Function` を差し替えられるか | ❌ ローカルでは `env.UNSAFE_EVAL === undefined`（wrangler が `remote` と表示） |
| `entry6.js` | Worker Loader バインディングで動的コード実行 | ✅ `{"hasLoader":true,"dynamicResult":"3"}` |

## 実測値

- **バンドルサイズ: raw 3,185,891 bytes / gzip 570,053 bytes**
  Workers の上限（Free 3 MB gzip / Paid 10 MB gzip）に大きく余裕あり
- `build.mjs` は `--conditions=workerd,worker,browser,import` で解決し、Node 組み込みを external に、`isolated-vm` と `node-gyp-build` を `stub.mjs` プラグインで空実装に置換している
- `wrangler.jsonc` 側では `alias` で `isolated-vm` → `ivm-stub.cjs` を指定

## 真のブロッカー

```
EvalError: Code generation from strings disallowed for this context
  at new Function (<anonymous>)
  at FunctionEvaluator.getFunction   (@n8n/tournament)
  at FunctionEvaluator.evaluate      (@n8n/tournament)
  at Tournament.execute
```

n8n の式エンジンには `legacy` と `vm` の 2 実装があり（env `N8N_EXPRESSION_ENGINE`）、**既定の `legacy` は `isolated-vm` を必要としない**。しかしその `legacy` 実装が `@n8n/tournament` の `FunctionEvaluator` 内で `new Function(...)` を使う。Cloudflare Workers はリクエスト処理中の動的コード生成を全面的に禁止しているため、ここで止まる。

**つまり Workers 上での n8n 式評価のブロッカーは「`isolated-vm`（ネイティブアドオン）」ではなく「`new Function`（ランタイムポリシー）」である。** この区別は Web 上のどの記事にも書かれていない。

## 回避策の検証結果

`entry6.js` が示すとおり **Worker Loader バインディング（`worker_loaders`）でローカル workerd 上の動的コード実行に成功**している。`@n8n/tournament` の `FunctionEvaluator` をこれに差し替えれば式評価は通る見込み。

ただし **`new Function` は同期、Worker Loader は非同期**なので、tournament 側の同期 API を非同期化する改造が必要。詳細は `PLAN.md` の Phase B-1 を参照。
