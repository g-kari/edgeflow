# edgeflow

**Cloudflare Workers 上で動くワークフロー自動化ツール。** 個人利用・非商用の技術研究プロジェクトです。

定期実行のバッチ（cron で API を叩き、加工し、通知する）を主な用途として、ゼロから設計・実装しています。将来的にはビジュアルエディタまで作りますが、まずは実行エンジンから積み上げています。

現在の設計は **[docs/superpowers/specs/2026-07-30-workflow-engine-design.md](./docs/superpowers/specs/2026-07-30-workflow-engine-design.md)** にあります。
セットアップ、定義登録、手動実行、履歴確認は **[docs/USAGE.md](./docs/USAGE.md)** を参照してください。

---

## 経緯 — なぜゼロから作るのか

このリポジトリは元々「n8n を Cloudflare Workers で動かす」ことを目指して始まりました。**結論として、それは原理的に不可能でした。**

| ブロッカー | 内容 |
|---|---|
| バンドルサイズ | n8n は数百 MB〜1GB。Workers の上限は gzip 10MB（**2 桁違い**） |
| メモリ | アイソレートあたり 128MB。n8n はアイドルで 300–500MB |
| `child_process` | スタブのみ。Task Runner が起動できない |
| `node:vm` | スタブのみ。Code ノードのサンドボックスが動かない |
| ネイティブアドオン | `sqlite3` `isolated-vm` `@sentry/node-native` 等が使えない |
| 永続ディスク | `node:fs` は仮想 FS で、`/tmp` はリクエストごとに揮発 |
| 実行時 npm install | 動的 `import()` が静的解析できないため community node が入らない |

代替として **Dafthunk**（MIT、Cloudflare ネイティブ、460 ノード）も検討しましたが、セルフホストに Cloudflare Containers 3 つ・OAuth アプリ・8 種のリソース作成が必要で重く、**自前で作る**判断に至りました。

調査の全記録は **[PLAN.md](./PLAN.md)** にあります。Cloudflare の制限値一覧、`nodejs_compat` の実態、Containers の料金試算など、この分野で作業する人には有用なはずです。

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

**Workers 上での式評価のブロッカーは `isolated-vm`（ネイティブアドオン）ではなく `new Function`** でした。Workers はリクエスト処理中の動的コード生成を全面禁止しています。

**解決策はコード生成をやめることでした。** `@n8n/tournament` の `getExpressionCode()` は AST 変換のみで eval を使わないため、その出力を `esprima-next` で AST 化し、**ツリーウォーク型インタプリタで直接解釈**します。

```
tournament.getExpressionCode(expr)   ← AST 変換のみ。eval なし
        ↓  JS ソース文字列
esprima.parseScript(...)             ← AST 化。eval なし
        ↓  AST
interpreter.run(ast, data, E)        ← ツリーウォーク。完全に同期
```

`new Function` も `eval` も一度も使わないため、**単一の通常 Worker で完結**します。この式エンジンが edgeflow の中核になります。

## experiments/

| ディレクトリ | 内容 |
|---|---|
| [`single-worker-interpreter/`](./experiments/single-worker-interpreter/) | **採用構成の原型。** 式インタプリタによる単一 Worker 完結 |
| [`workerd-n8n-workflow/`](./experiments/workerd-n8n-workflow/) | `n8n-workflow` の workerd 動作検証。真のブロッカーの特定 |
| [`expression-worker-loader/`](./experiments/expression-worker-loader/) | Worker Loader による式評価 |
| [`engine-in-dynamic-worker/`](./experiments/engine-in-dynamic-worker/) | 実行エンジンを動的 Worker に載せる方式。Worker Loader のサイズ上限測定 |
| [`neon-connectivity/`](./experiments/neon-connectivity/) | Neon への接続経路検証（採用見送り。参考資料） |

各ディレクトリの `README.md` に手順と結果、ハマった点を記録しています。

## 設計の要点

| 項目 | 決定 |
|---|---|
| 主な用途 | 定期実行のバッチ |
| 実行モデル | 単一値パイプライン + **Cloudflare Workflows**（ノード 1 つ = `step.do()` 1 つ） |
| 永続層 | **D1**（定義・実行履歴）+ **R2**（大きなペイロード） |
| 式 | `{ $expr: "{{ ... }}" }` 形式。ツリーウォークインタプリタで評価 |
| 失敗時 | リトライ後に停止（Workflows の既定挙動に委譲） |
| 認証情報 | Wrangler Secrets |
| コスト | **Workers Paid $5/月**に収める |

外部 PostgreSQL は不要です。

---

## ライセンスと第三者ソフトウェアとの関係

**このリポジトリに n8n のソースコードは一切含まれていません。** すべて自作のコードと分析文書です。

式評価には **`@n8n/tournament`（Apache-2.0）** を npm 依存として利用しています。調査段階では `n8n-workflow` も利用しました。n8n 本体は **Sustainable Use License v1.0** で、許諾範囲は「internal business purposes」または「non-commercial or personal use」です。本プロジェクトは個人の技術研究であり、この範囲内にあります。**本成果物をホスティングサービスとして第三者に提供することはできません。**

詳細は [NOTICE.md](./NOTICE.md) を参照してください。

**n8n は n8n GmbH の、Cloudflare は Cloudflare, Inc. の商標です。本プロジェクトはこれらいずれの企業とも無関係であり、承認・提携・後援を受けていません。**

## 免責

無保証です。実験的なコードであり、本番利用を想定していません。
