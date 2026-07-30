# CLAUDE.md — edgeflow

Cloudflare Workers 上で動くワークフロー自動化ツール。個人利用・非商用。

- 設計仕様: `docs/superpowers/specs/2026-07-30-workflow-engine-design.md`
- 実装計画: `docs/superpowers/plans/2026-07-30-workflow-engine.md`
- 調査記録: `PLAN.md`（Cloudflare の制限値、n8n の内部構造、実測データ）

## 言語

**日本語で応答し、日本語でコミットメッセージを書く。** コード中のコメントも日本語。識別子と技術用語は原語のまま。

---

## 絶対に踏んではいけない罠

すべて本プロジェクトで実際に踏んで解決したもの。**知らずに書くと必ず失敗する。**

### 1. `new Function` と `eval` を使わない

Cloudflare Workers は**リクエスト処理中の動的コード生成を全面禁止**している。使うと `EvalError: Code generation from strings disallowed for this context` になる。

式評価はこの経路で行う。**コード生成せずに AST を直接解釈する。**

```
tournament.getExpressionCode(expr)   ← AST 変換のみ。eval なし
        ↓  JS ソース文字列
esprima.parseScript(...)             ← AST 化。eval なし
        ↓  AST
interpreter.run(ast, data, E)        ← ツリーウォーク。完全に同期
```

`src/interpreter.ts` がその実装。**ここに `new Function` を足してはいけない。**

### 2. esbuild で事前バンドルしない

**wrangler に直接バンドルさせる**（`wrangler.jsonc` の `main` にソースを指定）。

esbuild で Node 組み込みを `external` にすると、ネストした `require()` が esbuild の `__require` シムに落ちて必ず失敗する。

```
Uncaught Error: Dynamic require of "assert" is not supported
  at node_modules/recast/main.js
```

`fs` をスタブ化すると次は `assert` で同じことが起きる。**個別に潰しても終わらない。** wrangler 内蔵のバンドラは `nodejs_compat` の解決を正しく行う。

### 3. `n8n-workflow` に依存しない

実行時依存は **`@n8n/tournament`（Apache-2.0）、`esprima-next`（BSD-2-Clause）、`zod`** の 3 つだけ。

`n8n-workflow` は gzip 570KB あり、かつ Sustainable Use License である。**素の `new Tournament()` でも `$json` は `this` 経由で解決され、危険な式は `interpreter.ts` の `BLOCKED_KEYS` が遮断する**ため、n8n の AST サニタイザは不要。依存を足そうとする前に必ずここを読むこと。

### 4. `$now` はノードごとに取らない

Workers のタイマーは**「最後の I/O 時点」で止まる**。ノードごとに `Date.now()` を呼ぶと値がばらつき、しかも意味のある時刻にならない。

**実行開始時に 1 度だけ確定させ、全ノードに同じ値を配る。**

### 5. `step.do()` の戻り値は 1 MiB 上限

超えると実行が失敗する。**512 KB を超えたら R2 に退避して参照だけ返す**（`src/storage.ts`）。JSON 化後のサイズは事前に読みづらいのでマージンを取ってある。

### 6. 4xx を無条件にリトライしない

401 を 5 回投げて 50 秒待つことになる。**429 と 5xx はリトライ、それ以外の 4xx は `NonRetryableError`。** 式のエラーとスキーマ不備もリトライ不可。`src/errors.ts` の `isRetryableStatus` を使う。

---

## 予算と計測

| 項目 | 上限 | 参考実測 |
|---|---|---|
| バンドル（gzip） | **10 MB** | 調査時点で 627.92 KiB（`n8n-workflow` 込み） |
| startup | **1,000 ms** | 本番 103 ms / ローカル 109 ms |

**ローカル計測は本番とほぼ一致する**ことを実証済み（差 5.5%）。したがってローカルで測る意味がある。

```bash
npm run size      # gzip サイズ
npm run startup   # startup プロファイル生成
node -e "const p=require('./worker-startup.cpuprofile');console.log(((p.endTime-p.startTime)/1000).toFixed(1)+' ms')"
```

**依存を足したら必ず測る。** startup 超過は依存のマイナーアップデートだけで非決定的に起きる報告がある。

---

## Workers の制約（設計判断に効くもの）

| 項目 | 値 |
|---|---|
| メモリ / isolate | 128 MB |
| CPU / リクエスト | 30 秒（既定）／最大 5 分 |
| **同時アウトバウンド接続** | **6**（並列 `fetch` を増やさない） |
| Cron Triggers | Paid 250 |
| Workflows 最大ステップ数 | Paid 10,000 |
| D1 最大サイズ | 10 GB。**DB 単位でシングルスレッド** |
| D1 行サイズ | 2 MB |
| `child_process` / `node:vm` | **スタブのみ**（機能しない） |
| 生 TCP | **不可**（Postgres 等への直結は恒久的に不可能） |

`compatibility_date` は **2025-09-15 以降**、`compatibility_flags` は `["nodejs_compat"]`。

---

## テスト

**純粋なロジック**（`schema.ts` / `graph.ts` / `expression.ts` / `interpreter.ts`）は素の Vitest で厚く書く。入出力が決まる計算なので速い。特に `graph.ts` は分岐・スキップ・到達不能の組み合わせでバグりやすいため表駆動にする。

**ノードと統合**は `@cloudflare/vitest-pool-workers` で workerd 内。実際の D1 / R2 バインディングが使え、テストファイル単位で storage が分離される。`fetch` は `vi.stubGlobal` で差し替える。

```bash
npm test           # 全件
npm run typecheck  # tsc --noEmit
```

**テストを書かずに実装を進めない。** 失敗するテスト → 実行して失敗を確認 → 最小実装 → 実行して成功を確認 → コミット。

---

## 設計上の約束

**式の解決はノードを呼ぶ前に済ませる。** ノード実装は `$expr` の存在を知らない。`NodeContext.params` は解決済みの値だけを持つ。この分離を壊さないこと。

**Cloudflare を抽象化しない。** Cloudflare 専用のツールなので直接使う。純関数にするのは `schema` / `graph` / `expression` / `interpreter` の 4 つだけで、理由は「純粋なロジックはテストしやすい」に限る。移植性のための抽象層を作らない。

**`workflow.ts` はアダプタではない。** Workflows の作法どおり `await step.do(...)` をインラインで書く。制御を反転させない。

**循環グラフは禁止。** スキーマ検証で弾く。ループが必要になったら専用ノードで明示的に扱う。

---

## ライセンス

n8n のソースコードをこのリポジトリに取り込まない。`@n8n/tournament` は **Apache-2.0** なので取り込む場合は帰属表示を行う。詳細は `NOTICE.md`。

**本成果物をホスティングサービスとして第三者に提供することはできない。**
