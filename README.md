# cf-n8n

**n8n のワークフローを Cloudflare Workers 上で実行するための研究リポジトリです。**

n8n 本体を移植するのではなく、**n8n のワークフロー JSON を入力フォーマットとして受け取り、Workers ネイティブの自前ランタイムで実行する**方向を採っています。個人利用・非商用の技術研究です。

現在は調査と実証（PoC）の段階で、実用プロダクトではありません。設計の全体像と根拠は **[PLAN.md](./PLAN.md)** にまとめてあります。

---

## なぜ n8n をそのまま動かさないのか

Cloudflare Workers（workerd）上で n8n 本体を動かすことは原理的に不可能です。独立した 7 つのブロッカーが同時に効きます。

| ブロッカー | 内容 |
|---|---|
| バンドルサイズ | n8n は数百 MB〜1GB。Workers の上限は gzip 10MB（**2 桁違い**） |
| メモリ | アイソレートあたり 128MB。n8n はアイドルで 300–500MB |
| `child_process` | スタブのみ。Task Runner が起動できない |
| `node:vm` | スタブのみ。Code ノードのサンドボックスが動かない |
| ネイティブアドオン | `sqlite3` `isolated-vm` `@sentry/node-native` 等が使えない |
| 永続ディスク | `node:fs` は仮想 FS で、`/tmp` はリクエストごとに揮発 |
| 実行時 npm install | 動的 `import()` が静的解析できないため community node が入らない |

詳細は [PLAN.md §5.1](./PLAN.md) を参照してください。

## 実証できたこと

すべて実測です。再現用のファイルは `experiments/` 配下にあります。

| # | 検証内容 | 結果 |
|---|---|---|
| 1 | `n8n-workflow` は workerd 上で動くか | ✅ **gzip 570KB**、`new Workflow()` 構築成功 |
| 2 | 式評価の真のブロッカーは何か | **`isolated-vm` ではなく `new Function`**（ランタイムポリシー）と判明 |
| 3 | Worker Loader で式評価できるか | ✅ 成功。n8n 本体と同一のサンドボックスも機能 |
| 4 | 実行エンジンごと動的 Worker に載せられるか | ✅ 成功。Worker Loader は **20MB のモジュールまで**受け付ける |
| 5 | **単一 Worker で完結できるか** | ✅ **成功。インタプリタ方式で Worker Loader 自体が不要に** |
| 6 | 本番で動くか | ✅ **startup 103 ms**（上限 1,000ms）、ローカルと完全に同一の結果 |

### 鍵になった発見

**Workers 上での n8n 式評価のブロッカーは `isolated-vm`（ネイティブアドオン）ではなく `new Function`** でした。n8n の式エンジンには `legacy` と `vm` の 2 実装があり、既定の `legacy` は isolated-vm を必要としません。しかしその `legacy` が `@n8n/tournament` 内で `new Function` を使い、Workers はリクエスト処理中の動的コード生成を全面禁止しています。

**解決策はコード生成をやめることでした。** `getExpressionCode()` は AST 変換のみで eval を使わないため、その出力を `esprima-next` で AST 化し、**ツリーウォーク型インタプリタで直接解釈**します。

```
tournament.getExpressionCode(expr)   ← AST 変換のみ。eval なし
        ↓  JS ソース文字列
esprima.parseScript(...)             ← AST 化。eval なし
        ↓  AST
interpreter.run(ast, data, E)        ← ツリーウォーク。完全に同期
```

`new Function` も `eval` も一度も使わないため、**単一の通常 Worker で完結**します。

## experiments/

| ディレクトリ | 内容 |
|---|---|
| [`workerd-n8n-workflow/`](./experiments/workerd-n8n-workflow/) | `n8n-workflow` の workerd 動作検証。真のブロッカーの特定 |
| [`expression-worker-loader/`](./experiments/expression-worker-loader/) | Worker Loader による式評価（PoC-2） |
| [`engine-in-dynamic-worker/`](./experiments/engine-in-dynamic-worker/) | 実行エンジンを動的 Worker に載せる方式。Worker Loader のサイズ上限測定 |
| [`single-worker-interpreter/`](./experiments/single-worker-interpreter/) | **採用構成。** 式インタプリタによる単一 Worker 完結 |
| [`neon-connectivity/`](./experiments/neon-connectivity/) | Neon への接続経路検証（採用見送り。参考資料） |

各ディレクトリの `README.md` に手順と結果、ハマった点を記録しています。

## 現在の状態

- **アーキテクチャ**: 単一 Worker + 式インタプリタ
- **永続層**: D1（PostgreSQL は不要）
- **実測**: バンドル gzip 627.92 KiB / startup 本番 103 ms
- **次の作業**: ワークフローのグラフ走査とノード間のデータ受け渡し

---

## ライセンスと n8n との関係

**このリポジトリに n8n のソースコードは一切含まれていません。** すべて自作のコードと分析文書です。`package.json` は `n8n-workflow` 等を npm の依存として宣言していますが、それらは利用者が npm から取得します。

n8n は **Sustainable Use License v1.0** で提供されており、以下の制約があります。

- 許諾範囲は **「internal business purposes」または「non-commercial or personal use」**
- 再配布は**非商用かつ無償**の場合のみ
- **商用ホスティング・SaaS 提供・第三者の便益のための提供は不可**

本リポジトリは**個人の技術研究**であり、この範囲内にあります。**本成果物をホスティングサービスとして第三者に提供することはできません。**

`@n8n/tournament` のみ Apache-2.0 です。将来コードを取り込む場合は帰属表示を行います。

**n8n は n8n GmbH の商標です。本プロジェクトは n8n GmbH とは無関係であり、同社による承認・提携・後援を受けていません。** 「n8n」の名称は、互換対象を説明するためだけに使用しています。

分析文書中の n8n・Cloudflare・Neon のソースコードやドキュメントからの引用は、技術的な解説を目的とした短い抜粋です。

## 免責

無保証です。実験的なコードであり、本番利用を想定していません。
