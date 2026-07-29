# Phase 1: 実行エンジンごと動的 Worker に載せる

実施日 2026-07-30 / `n8n-workflow@2.16.0` + `@n8n/tournament@1.8.1` / `wrangler 4.115.0`

**結論: 成功。Track B のアーキテクチャが端から端まで通りました。** n8n の実行エンジンを Worker Loader が作る動的 Worker の中で動かし、式評価を**同期のまま**解決できています。

## なぜこの構成なのか

`experiments/expression-worker-loader/`（PoC-2）で式評価は動きましたが、**動的 Worker への呼び出しは非同期**です。一方 n8n-workflow の式評価インタフェースは同期（`evaluateExpression(expr, data)`）で、この不一致をどう吸収するかが残っていました。

答えは **「実行エンジンごと動的 Worker の中に入れる」** です。こうすると非同期境界は「動的 Worker を生成する 1 回」だけになり、**エンジン内部の式評価はテーブル参照の同期処理**で済みます。

```
外側 Worker                          動的 Worker（Worker Loader が生成）
─────────────                        ────────────────────────────────
workflow JSON を読む                  ┌ engine.js  … n8n-workflow バンドル(3.45MB)
  ↓                                   │             globalThis.__CFN8N__ に公開
式を収集                              │
  ↓                                   └ main.js    … 式テーブル（コンパイル済み関数）
tournament でコンパイル ──────────────▶              + registerExpressionTable()
（AST 変換のみ / eval なし）                          + new Workflow() で実行
  ↓                                                  ★ 式評価はテーブル参照＝同期
Worker Loader に 2 モジュールを渡す
```

**エンジンは全ワークフローで共通、式テーブルだけがワークフローごとに変わる**ため、`env.LOADER.get(id, ...)` の id をワークフロー ID + 版数にすれば動的 Worker を使い回せます。

## 手順

```bash
npm install
npm run build:engine     # wrangler で内側エンジンをバンドル → engine-bundle.txt
npm run dev
curl http://127.0.0.1:8787/
```

## 結果

実行結果は `result.json`。ワークフローの 3 パラメータすべてが正しく解決されました。入力は `{ $json: { who: 'gizen', n: 7 } }` です。

| パラメータ | 式 | 解決値 |
|---|---|---|
| `greeting` | `={{ "hello " + $json.who }}` | `"hello gizen"` |
| `doubled` | `={{ $json.n * 2 }}` | `14` |
| `listed` | `={{ [1,2,3].map(x => x + $json.n).join("|") }}` | `"8\|9\|10"` |

文字列連結、算術、`$json` アクセス、そして **`$json.n` をクロージャで捕捉するアロー関数**まで動いています。`new Workflow()` は動的 Worker の中で構築され、n8n によるパラメータ正規化も経ています。

## Worker Loader のモジュールサイズ上限

`loader-size-probe.js` で測定しました（結果は `loader-size-result.json`）。

| サイズ | 結果 |
|---|---|
| 512KB / 1MB / 3MB / 5MB / 10MB / **20MB** | **すべて成功** |

**少なくとも 20MB までは通ります。** エンジンバンドル 3.45MB は余裕で収まります。

⚠️ **これはローカル workerd での測定です。** 本番ネットワークでの上限は未確認で、`unsafe_eval` バインディングがローカルで使えなかった前例（PoC-2）があるため、実デプロイ時に再確認が必要です。

## ビルドパイプライン

エンジンのバンドルには **`wrangler deploy --dry-run --outdir=dist`** を使います。**Cloudflare の認証は不要**で、ローカルだけで完結します。

```
Total Upload: 3369.50 KiB / gzip: 582.80 KiB
```

外側 Worker はこれを `rules` の Text ローダーで文字列として取り込みます。

```jsonc
"rules": [{ "type": "Text", "globs": ["**/*.txt"], "fallthrough": true }]
```

**esbuild で事前バンドルしてはいけません**（`experiments/expression-worker-loader/` 参照）。Node 組み込みを `external` にすると、ネストした `require()` が `__require` シムに落ちて `Dynamic require of "assert" is not supported` で必ず失敗します。wrangler 内蔵のバンドラは `nodejs_compat` の解決を正しく行います。

## ハマった点

**1. wrangler は `export default` が無いと IIFE を吐く**

エンジンから名前付き export だけを出そうとしたところ、バンドルが `(() => { ... })()` に包まれて export が消え、`The requested module './engine.js' does not provide an export named 'Workflow'` になりました。

**解決策は `globalThis` 経由の受け渡し**です。バンドラの出力形式（ESM / IIFE）に依存しなくなります。

```js
globalThis.__CFN8N__ = { Workflow, registerExpressionTable, evaluateExpression };
export default { async fetch() { return new Response('engine'); } };
```

**2. n8n は node description に宣言のないパラメータを削除する**

ダミーの node type を `properties: []` で作ったところ、`new Workflow()` 後にパラメータが全部消えて解決結果が空になりました。n8n は `NodeHelpers.getNodeParameters()` で description に照らして正規化するためです。

```js
properties: [
  { displayName: 'Greeting', name: 'greeting', type: 'string', default: '' },
  ...
]
```

**ノード実装では description の properties 宣言が必須**になります。これは n8n 互換を名乗る以上むしろ正しい挙動なので、仕様として受け入れます。

## 次に検証すべきこと

- **式拡張関数**（`.toSnakeCase()` 等、`@n8n/expression-runtime` の extensions）が動的 Worker 内で使えるか
- `$now` / `$today`（Luxon 依存）。Workers のタイマーは「最後の I/O 時点」で止まる仕様
- **動的 Worker の生成レイテンシ**。3.45MB のパースにどれだけかかるか。`env.LOADER.get()` のキャッシュがどこまで効くか
- ワークフローの**グラフ走査と実際のノード実行**（現状はパラメータ解決までで、ノード間のデータ受け渡しは未実装）
- **本番ネットワークでの Worker Loader の挙動**
