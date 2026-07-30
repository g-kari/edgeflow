# ワークフロー実行エンジン 設計仕様

作成日: 2026-07-30 / 対象: サブプロジェクト 1（定義スキーマ + 実行エンジン）

## 1. 背景と位置づけ

Cloudflare Workers 上で動くワークフロー自動化ツールをゼロから作る。n8n 互換は追わず、Dafthunk のフォークもしない。

**当初は n8n を Workers に載せることを目指していたが、原理的に不可能と判明した。** バンドルサイズ（n8n は数百 MB〜1GB、上限は gzip 10MB）、メモリ 128MB、ネイティブアドオン非対応、`child_process` と `node:vm` がスタブ、永続ディスクなしという独立した制約が同時に効く。詳細は `PLAN.md` に記録した。

代替の Dafthunk（MIT、Cloudflare ネイティブ、460 ノード）も検討したが、セルフホストに Cloudflare Containers 3 つ・OAuth アプリ・8 種のリソース作成が必要で重い。自前で作る判断に至った。

### 全体のサブプロジェクト分割

ビジュアルエディタまで含めると 1 つの仕様に収まらないため分割する。

| # | subsystem | 状態 |
|---|---|---|
| 1 | **定義スキーマ + 実行エンジン** | **本仕様** |
| 2 | 永続層 + REST API | 未着手 |
| 3 | ビジュアルエディタ（React Flow） | 未着手 |
| 4 | トリガー拡充 | 一部を本仕様に含む（cron / 手動） |
| 5 | ノードライブラリ拡充 | 未着手 |
| 6 | 認証 | 未着手 |

**本仕様の完了条件**: cron で定期バッチが実際に回り、実行履歴が D1 に残る。定義 JSON は手書きでよい。エディタは含まない。

## 2. 要件

### 決定事項

| 項目 | 決定 |
|---|---|
| 主な用途 | **定期実行のバッチ**（cron で API を叩き、加工し、通知する） |
| 定義方法 | JSON（将来ビジュアルエディタが生成する。本仕様では手書き） |
| ノード | **HTTP / 変換 / 分岐 / 通知** の 4 種 |
| 失敗時の既定挙動 | **リトライ後に停止** |
| 認証情報 | **Wrangler Secrets**（式から `$secrets.NAME` で参照） |
| 実行モデル | **単一値パイプライン + Cloudflare Workflows** |
| コスト目標 | Workers Paid **$5/月**に収める |

### 実行モデルの選択理由

各ノードは値 1 つを受けて値 1 つを返す。**ノード 1 つ = Workflows の `step.do()` 1 つ**に対応させる。

n8n 風の items 配列モデル（暗黙のファンアウト）は採らない。理由は 3 つ。

**Workflows がリトライと永続化を提供する。** 「リトライ後に停止」は Workflows の既定挙動そのもので、自前実装が不要になる。`step.do()` の wall time は無制限、課金は CPU 時間のみなので API 応答待ちが無料。

**式インタプリタがあるため配列処理をエンジンから追い出せる。** `{{ $json.filter(i => i.active).map(i => i.title) }}` で足りる。実測で動作を確認済み（`experiments/single-worker-interpreter/`）。

**YAGNI。** 暗黙のファンアウトは n8n で最も理解しづらい機能であり、定期バッチには過剰。後から items モデルへ寄せることは可能だが、逆は難しい。

**受け入れた弱点**: 「100 件それぞれについて API を叩く」は式内で解決するか、将来ループノードを追加する。`step.do()` の戻り値 1 MiB 上限には R2 退避で対応する（§6）。

## 3. 既知の制約（実測値）

すべて本プロジェクトで実測または公式ドキュメントで確認した。

| 項目 | 値 |
|---|---|
| Worker スクリプトサイズ | gzip **10 MB**（Paid）。現状の実測は 627.92 KiB |
| startup 時間 | 上限 **1 秒**。実測は**本番 103 ms / ローカル 109 ms** |
| メモリ / isolate | 128 MB |
| CPU / リクエスト | 30 秒（既定）／最大 5 分 |
| 同時アウトバウンド接続 | **6** |
| Cron Triggers | Paid **250** |
| `step.do()` 戻り値 | **1 MiB** |
| Workflows 最大ステップ数 | Paid 10,000 |
| Workflows `step.sleep` | 最大 365 日 |
| D1 最大 DB サイズ | 10 GB。**DB 単位でシングルスレッド** |
| D1 行サイズ | 2 MB |
| `new Function` / `eval` | **リクエスト処理中は禁止** |
| `child_process` / `node:vm` | スタブのみ（機能しない） |
| 生 TCP | 不可（DB 直結不可） |

**ローカルの startup 計測が本番とほぼ一致することを実証済み**（差 5.5%）。したがって CI で `wrangler check startup` を回す方針に根拠がある。

## 4. アーキテクチャ

```
Cron Trigger ──┐
               ├─▶ Worker（単一）
手動実行 HTTP ──┘      │
                      │ 1 実行 = 1 Workflow インスタンス
                      ▼
              Cloudflare Workflows
                      │  ノード 1 つ = step.do() 1 つ
                      ▼
        ┌─────────────┴─────────────┐
        ▼                           ▼
   D1（定義・実行履歴）        R2（512KB 超のペイロード）
                                    ▲
                          Wrangler Secrets（認証情報）
```

Worker は 1 つ。cron ハンドラ、手動実行エンドポイント、`WorkflowEntrypoint` を同じスクリプトに同居させる。startup 予算に余裕があるため分割しない。

### モジュール構成

| ファイル | 責務 | 純関数 |
|---|---|---|
| `schema.ts` | 定義の型と Zod 検証、グラフ健全性検証 | ✅ |
| `graph.ts` | 実行順の決定、分岐と辺の活性化 | ✅ |
| `expression.ts` | 式のコンパイルと評価 | ✅ |
| `nodes/*.ts` | 4 種のノード実装。`fetch` を直接使う | ー |
| `workflow.ts` | `WorkflowEntrypoint`。`step.do()` を直接呼ぶ | ー |
| `storage.ts` | D1 記録、R2 退避 | ー |
| `index.ts` | cron ハンドラ + 手動実行エンドポイント | ー |

**Cloudflare を抽象化しない。** Cloudflare 専用のツールなので直接使う。純関数にするのは `schema` `graph` `expression` の 3 つだけで、これは「純粋なロジックは純関数にするとテストしやすい」という理由のみに基づく。移植性を目的とした抽象は作らない（YAGNI）。

**`workflow.ts` はアダプタではない。** Workflows の作法どおり `await step.do(...)` をインラインで書く。制御を反転させて「次のノードを返す」設計にはしない。

## 5. ワークフロー定義スキーマ

エディタとエンジンの契約になる。

```ts
type Workflow = {
  schemaVersion: 1
  id: string
  name: string
  trigger:
    | { type: 'cron'; cron: string }
    | { type: 'manual' }
  nodes: Node[]
  edges: Edge[]
  defaultRetryLimit?: number      // 省略時 3
}

type Node = {
  id: string                      // ワークフロー内で一意
  type: 'http' | 'transform' | 'if' | 'notify'
  name: string                    // 表示名。式から $nodes['名前'] で参照される
  params: Record<string, ParamValue>
  retry?: { limit: number }
}

type Edge = {
  from: string                    // Node.id
  to: string                      // Node.id
  branch?: 'true' | 'false'       // if ノードの 2 出力を区別
}

type ParamValue = Literal | { $expr: string }
type Literal = string | number | boolean | null | Literal[] | { [k: string]: Literal }
```

### 式は `$expr` オブジェクト形式

n8n は文字列先頭の `=` で式を表すが、**`=` で始まるリテラル文字列が書けなくなる**。n8n 互換をやめたのでこの負債を引き継がない。`{ $expr: "..." }` は曖昧さがなく Zod 検証も素直。

式の中身は `{{ }}` を含むテンプレートとする。**文字列補間がそのまま使える**（実測で `"Hello gizen, you are 42"` を確認）。

```jsonc
{ "$expr": "Hello {{ $json.name }}、{{ $json.items.length }} 件あります" }
{ "$expr": "{{ $json.total * 1.1 }}" }
```

### 式から見える変数

| 変数 | 内容 |
|---|---|
| `$json` | 直前のノードの出力 |
| `$nodes['名前']` | 任意のノードの出力（`Node.name` で参照） |
| `$secrets.NAME` | Wrangler Secrets の値 |
| `$now` | 実行開始時刻（ISO 文字列と Date の両方を提供） |
| `$run` | 実行 ID、ワークフロー名、試行回数 |

**`$now` は実行開始時に 1 度だけ確定させ、全ノードに同じ値を配る。** Workers のタイマーは「最後の I/O 時点」で止まるため、ノードごとに現在時刻を取ると値がばらつき意味を持たない。定期バッチでは「この実行の基準時刻」が一貫している方が正しい。

### 式評価の実装

`experiments/single-worker-interpreter/interpreter.js` をそのまま流用する。

```
tournament.getExpressionCode(expr)   ← AST 変換のみ。eval なし
        ↓  JS ソース文字列
esprima.parseScript(...)             ← AST 化。eval なし
        ↓  AST
interpreter.run(ast, data, E)        ← ツリーウォーク。完全に同期
```

**Workers は `new Function` / `eval` をリクエスト処理中に禁止している**ため、コード生成せずに評価する必要がある。この経路は実測で 17 式すべて成功を確認済み。

セキュリティは三重。`@n8n/tournament` の AST フック（`ThisSanitizer` / `PrototypeSanitizer` / `DollarSignValidator`）がコンパイル段階で危険な式を拒否し、インタプリタの `BLOCKED_KEYS` が `__proto__` / `constructor` 等を実行時に遮断し、`SAFE_GLOBALS` の allowlist だけを公開する（`globalThis` を晒さないため Worker のバインディングや `fetch` に到達不可）。**インタプリタは解釈できる AST ノード型しか実行しない**ため、既定が拒否側に倒れている。

コンパイル結果はワークフロー単位でキャッシュする。

### 検証

Zod による型検証に加え、**グラフの健全性を保存時とロード時の両方で検査**し、壊れた定義を D1 に入れない。

- エントリノード（入力辺なし）がちょうど 1 つ存在するか
- 存在しない `from` / `to` を参照していないか
- 循環参照がないか（**循環は禁止**。ループが必要なら将来専用ノードで明示的に扱う）
- 到達不能ノードがないか
- `branch` が `if` 以外のノードの出力辺に付いていないか
- `Node.id` と `Node.name` がそれぞれ一意か

## 6. 実行エンジン

### 実行順の決定

分岐があるため単純なトポロジカル順では足りない。**辺の活性化**で表現する。

1. ノードは**入力辺が 1 本以上活性化されたとき**に実行対象になる（エントリノードは無条件）
2. 実行後、**条件に合う出力辺のみを活性化**する（`if` は結果に応じて `true` か `false` の辺のみ、他は全出力辺）
3. **各ノードは 1 実行あたり最大 1 回**しか動かない

活性化されなかった辺しか持たないノードは**スキップ**として記録する。「実行されなかった」と「失敗した」を履歴上で区別するため。循環はスキーマ検証で禁止しているため必ず停止する。

**`if` ノードの結果に対応する出力辺が存在しない場合、その経路は正常終了として終わる。** 例えば `true` の辺だけが定義されていて結果が `false` になったとき、エラーにはせず単にそこで打ち切る。片方の分岐だけを繋ぐのは実用上よくある形であり、辺の欠落を異常扱いすると使いづらい。

**スキップの記録対象は「到達しなかったノード」全部**とする。分岐で選ばれなかった側の下流も含めて `skipped` を残す。履歴を見たときに「どちらの経路を通ったか」が一目で分かることを優先する。ノード数は高々数十なので行数は問題にならない。

### ノードのインタフェース

```ts
type NodeContext = {
  params: Record<string, unknown>   // 式は解決済み
  input: unknown                    // $json
  run: RunMeta                      // 実行 ID、$now、試行回数
}

type NodeResult = {
  output: unknown
  branch?: 'true' | 'false'         // if ノードのみ
}

type NodeImpl = (ctx: NodeContext) => Promise<NodeResult>
```

**式の解決はノードを呼ぶ前に済ませる。** ノード実装は `$expr` の存在を知らない。この分離によりノードは単なる非同期関数になり、テストは `{ params, input, run }` を渡すだけで済む。ノードを増やすときの認知負荷を最小にする。

### 4 種のノード

| type | 出力 | 備考 |
|---|---|---|
| `http` | `{ status, headers, body }` | メソッド・URL・ヘッダ・ボディ。`fetch` を直接使う |
| `transform` | 式の評価結果 | 実質「式 1 本を評価して返す」 |
| `if` | 入力をそのまま透過 | 条件式を評価し `branch` を返す |
| `notify` | 送信結果 | Slack / Discord の Webhook URL へ POST |

`http` ノードの出力は **`{ status: number, headers: Record<string,string>, body: unknown }`** の形に固定する。`body` は `Content-Type` が JSON なら parse 済みのオブジェクト、それ以外は文字列。ステータスコードを後続の `if` で判定したい場面があるため、body だけを返す形にはしない。式からは `{{ $json.body.items }}` や `{{ $json.status }}` で触る。

`notify` は実質 `http` のラッパだが専用ノードとして分ける。エディタで「Slack に送る」と「任意の API を叩く」が別物として見える方が使いやすく、Webhook URL の形式検証もできる。

**同時アウトバウンド接続は 6** という制約があるため、並列実行を導入する場合は並列度を絞る。本仕様の範囲では逐次実行のみ。

## 7. エラー処理とリトライ

### Workflows への写像

```ts
await step.do(node.name, {
  retries: {
    limit: node.retry?.limit ?? workflow.defaultRetryLimit ?? 3,
    delay: 10_000,
    backoff: 'exponential',
  },
  timeout: '2 minutes',
}, async () => runNode(node, ctx))
```

`timeout` は**試行ごと**に適用される（累積ではない）。

### リトライすべきかの判定

実装で最も間違えやすい部分。**無条件にリトライすると 401 を 5 回投げて 50 秒待つ**ことになる。

| エラー | 扱い |
|---|---|
| ネットワークエラー、HTTP 5xx、HTTP 429 | **リトライする** |
| HTTP 4xx（429 を除く） | `NonRetryableError` で即座に打ち切り |
| 式の評価エラー | `NonRetryableError` |
| スキーマ・設定の不備 | `NonRetryableError` |

429 は `Retry-After` を尊重する。Workflows の `delay` は関数を渡せるのでそこで反映する。

### 失敗の記録

リトライを使い切ったらワークフロー全体を失敗とし、**どのノードで何回試して何のエラーだったか**を D1 に残す。定期バッチは人が見ていないため、後から原因が分かることが唯一の救いになる。

## 8. データフローと実行履歴

### 1 MiB の壁

`step.do()` の戻り値は 1 MiB 上限で、HTTP ノードが大きな JSON を取得すると超える。

**出力が 512 KB を超えたら R2 に書き、参照だけを返す。**

```ts
type StepOutput =
  | { kind: 'inline'; value: unknown }
  | { kind: 'r2'; key: string; bytes: number }
```

次のノードが `$json` を触るときに透過的に読み戻す。閾値を上限より低く設定するのは、JSON 化後のサイズが事前に読みづらいためのマージン。

R2 のキーは `runs/{runId}/{nodeId}.json` とし、egress が無料なため読み戻しのコストは発生しない。

### D1 のテーブル

| テーブル | 主な列 |
|---|---|
| `workflows` | `id`, `name`, `definition`（JSON）, `cron`, `enabled`, `updated_at` |
| `runs` | `id`, `workflow_id`, `status`, `started_at`, `finished_at`, `error_summary`, `trigger_type` |
| `run_steps` | `run_id`, `node_id`, `node_name`, `status`, `attempts`, `duration_ms`, `output_preview`, `output_r2_key`, `error` |

`run_steps.status` は `success` / `failed` / `skipped` の 3 値。

**出力は D1 には切り詰めて入れ（`output_preview`、上限 4 KB）、全量は R2 に置く。** D1 は行 2 MB 上限があり、かつ**スキャン行数で課金される**ため履歴テーブルを太らせるとコストに跳ね返る。

`runs` には `workflow_id` と `started_at` に複合インデックスを張る（履歴一覧の主要クエリ）。

**D1 は DB 単位でシングルスレッド**なので、重いクエリを書かない。履歴のプルーニングは本仕様の範囲外だが、テーブル設計は削除しやすい形にしておく（`runs` を消せば `run_steps` も消せるよう `run_id` で引ける）。

## 9. トリガー

**cron**: `scheduled` ハンドラで発火。D1 から `enabled` かつ該当 cron のワークフローを引き、それぞれ Workflows インスタンスを作る。Cron Trigger は Paid で 250 個まで。`wrangler.jsonc` に書く cron 式と D1 の定義を一致させる運用が必要で、ここは将来 API 化する際の課題として記録する。

**手動実行**: `POST /runs`（`{ workflowId }`）で Workflows インスタンスを作り、`runId` を返す。開発とデバッグに使う。

いずれも**認証は本仕様の範囲外**（サブプロジェクト 6）。当面 Cloudflare Access で保護する前提とする。

## 10. テスト方針

**純関数は素の Vitest。** `schema` `graph` `expression` は入出力が決まる計算なのでここを厚くする。特に `graph` は分岐・スキップ・到達不能の組み合わせでバグりやすいため、表駆動でケースを並べる。

**ノードと全体は `@cloudflare/vitest-pool-workers` で workerd 内。** Miniflare 経由で実際の D1 / R2 バインディングを使い、テストファイル単位で storage が分離される。HMR で再実行が速い。`fetch` はテスト内で差し替える。

**ワークフロー全体はゴールデンテスト。** 定義 JSON と期待される実行結果（各ノードの出力と状態）をファイルで持ち突き合わせる。ノードを増やしたときの回帰検出に効く。

**CI で `wrangler check startup` とバンドルサイズを計測する。** startup 超過は依存の更新だけで非決定的に起きる報告があり、ローカル計測が本番と一致することは実証済みなので、継続測定に意味がある。

## 11. ビルドとデプロイ

**esbuild で事前バンドルしてはいけない。** Node 組み込みを `external` にするとネストした `require()` が esbuild の `__require` シムに落ち、`Dynamic require of "assert" is not supported` で必ず失敗する。**wrangler に直接バンドルさせる**（`main` にソースを指定）。wrangler 内蔵のバンドラは `nodejs_compat` の組み込みモジュール解決を正しく行う。

`compatibility_date` は **2025-09-15 以降**、`compatibility_flags` に `nodejs_compat` を指定する。

## 12. 未確認事項

実装時に最初に潰すべき順に並べる。

1. **`@cloudflare/vitest-pool-workers` が Workflows バインディングに対応しているか。** 公式ドキュメントで確認できなかった。非対応なら `step` 相当のテストダブルを渡して呼び出し順を検証する（アーキテクチャの抽象ではなくテストの継ぎ目として扱う）
2. **`tournament` + `esprima` を含めた状態でのバンドルサイズと startup 時間。** 現状の実測 627.92 KiB / 103 ms にノード実装と Workflows が乗るとどうなるか
3. **Workflows の `retries.delay` に関数を渡して `Retry-After` を反映できるか**の実装確認
4. **式拡張関数**（`.toSnakeCase()` 等、`@n8n/expression-runtime` の extensions）を使うか。使うならバンドルへの影響
5. **`$now` を Workflows のステップ間で一貫させる方法。** `step.do()` の戻り値経由で引き回すか、インスタンス作成時のパラメータに載せるか

## 13. スコープ外（明示）

本仕様に**含まない**もの。

- ビジュアルエディタ（サブプロジェクト 3）
- REST API 一式（サブプロジェクト 2。手動実行の 1 本のみ含む）
- 認証（サブプロジェクト 6）
- ループ構文、暗黙のファンアウト
- Code ノード（任意の JS 実行）。必要になれば Worker Loader を使うが本番未検証
- 認証情報の UI 管理（D1 暗号化保存）。Wrangler Secrets で始める
- 実行履歴のプルーニング
- 生 TCP を要するノード（Postgres / MySQL / Redis 等）。**Workers の制約により恒久的に不可能**
