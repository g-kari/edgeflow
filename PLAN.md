# cf-n8n — n8n を Cloudflare で動かす計画

調査日: 2026-07-29
対象: n8n master `2.33.0`（npm latest は `2.32.6`）/ Cloudflare Workers・Containers 公式ドキュメント + workerd 実測

凡例 — **【実測】** 本調査で実際に動かして確認 / **【事実】** 公式ドキュメント・公式リポジトリ・実ファイルで確認 / **【第三者】** ブログ・Issue 等 / **【推測】** 上記からの推論 / **⚠️** ソース間で矛盾しており要検証

---

## 1. 結論

**Workers 単体で n8n 本体を動かすことは原理的に不可能です。** バンドルサイズ・メモリ・ネイティブアドオン・`child_process`・`node:vm`・永続ディスク・実行時 npm install という 7 つの独立したブロッカーが同時に効きます（§5.1）。

しかし調査の過程で、**当初の想定より遥かに重要な発見が 2 つ**ありました。

**発見 1 — `n8n-workflow` は workerd 上で動く。【実測】**
`n8n-workflow@2.16.0` を esbuild でバンドルすると **gzip 570,053 bytes**（Paid 上限 10MB に対し余裕）、workerd 上で **`new Workflow()` の構築に成功**しました。詰まるのは式評価のみで、その原因は `isolated-vm`（ネイティブアドオン）ではなく **`@n8n/tournament` 内の `new Function`**（Workers のランタイムポリシーによる動的コード生成禁止）です。そして **Worker Loader バインディングによる動的コード実行はローカル workerd で成功しました。** つまり回避経路が実在します。

**発見 2 — Containers 経路には未検証の致命的リスクがある。⚠️**
Containers のディスクは公式に **完全に ephemeral** と明記されており、n8n は外部 PostgreSQL が必須になります。ところが **コンテナからの生 TCP アウトバウンド（Postgres 5432）が可能かどうか、Cloudflare 自身のドキュメント間で記述が矛盾しています。** ここが駄目なら Containers 上の n8n は成立しません。

したがって、**方針を決める前に 2 つの PoC を並行実施する**のが本計画の出発点です。

| PoC | 検証内容 | これが失敗したら |
|---|---|---|
| **PoC-1** | Container → 外部 PostgreSQL:5432 への生 TCP 接続 | 経路 A（Containers）が全滅 |
| **PoC-2** | `@n8n/tournament` の `FunctionEvaluator` を Worker Loader 化して式評価を通す | 経路 B（Workers ネイティブ）の難度が跳ね上がる |

**推奨する最終形は経路 B**（Workers ネイティブの n8n 互換ランタイム）です。経路 A は「動く n8n を早期に確保し、経路 B の互換性検証の正解データを提供するリファレンス環境」として位置づけます。理由は §6 に述べます。

---

## 2. n8n 側の事実

### 2.1 バージョンと Node 要件

| 項目 | 値 |
|---|---|
| master のバージョン | `2.33.0` |
| npm `latest` | `2.32.6` |
| `engines.node` | **`>=22.22`**【事実】 |
| パッケージマネージャ | `pnpm@10.32.1` |
| ライセンス | Sustainable Use License v1.0（`.ee` ファイルは Enterprise License） |

**⚠️ 落とし穴**: `n8n-core` / `n8n-workflow` / `n8n-nodes-base` の **npm `latest` dist-tag は大きく遅れています**（それぞれ 2.16.1 / 2.16.0 / 2.15.1）。実際の最新は `n8n` 本体の依存欄か GitHub master を見る必要があります。本計画の実測は `n8n-workflow@2.16.0`（= npm latest）で行いました。

n8n 公式ドキュメントには「Node.js 20.19〜24.x」という記述もありますが、**`package.json` の `engines` が `>=22.22` である以上そちらが正**です。ドキュメントが古いと見るべきです。

### 2.2 monorepo 構成と「移植しやすさ」の 3 層

`packages/` 直下は `@n8n/`, `cli/`, `core/`, `extensions/`, `frontend/`, `node-dev/`, `nodes-base/`, `testing/`, `workflow/` の 9 つ。`packages/@n8n/` 配下はさらに 54 ディレクトリあります。

移植可能性を決めるのは依存の純度で、きれいに 3 層に分かれます。

**第 1 層 `n8n-workflow` — ネイティブ依存ゼロ。移植の核。【事実】**

依存 25 件は `@n8n/tournament`（式評価）、`@n8n/expression-runtime`、`esprima-next` / `recast` / `ast-types`（AST 処理）、`axios`、`lodash`、`luxon`、`jmespath`、`xml2js`、`uuid` など。**dist 内で Node 組み込みモジュールを使っているのは `dist/cjs/utils.js:68` の `require("path")` 1 箇所のみ**。

`@n8n/expression-runtime` 経由で `isolated-vm` に届く経路はありますが**遅延ロード**なので、import 時には触られません。CJS/ESM 両対応で exports マップも整備済みです。

**なお `@n8n/tournament` のみ Apache-2.0** で、n8n 関連で唯一の OSS ライセンスです。

**第 2 層 `n8n-core` — 分離は可能だが Node 前提。【事実】**

master の依存にはバックエンド前提のものが並びます。移植の障害になるのは **`@sentry/node-native` と `@sentry/profiling-node`（いずれもネイティブアドオン）**、`ssh2`、`cron`、`fast-glob`、`file-type`、`chardet`、`winston`。加えて `@n8n/blob-storage`、`@n8n/backend-network`、`@n8n/di`（DI コンテナ）、`@langchain/core` に依存します。

実行本体は `packages/core/src/execution-engine/workflow-execute.ts`（**約 95.6 KB**）で、インメモリの再帰実行です。

**第 3 層 `n8n`（cli）と `n8n-nodes-base` — 移植不可能。【事実】**

`packages/cli` の本番依存に含まれる Node 固有・ネイティブ依存:

`sqlite3@5.1.7` / `isolated-vm@^6.1.2` / `@parcel/watcher@^2.5.1` / `@sentry/node-native` / `express@5.1.0`（v4 ではない）/ `@n8n/typeorm@0.6.0` / `pg@8.21.0` / `bull@4.16.4` + `ioredis@5.3.2` / `ws@8.20.1` / `bcryptjs@2.4.3`（純 JS）/ `shelljs` / `simple-git` / `cron@4.4.0` / `multer` / `formidable`

`n8n-nodes-base` 側で Workers に持ち込めないもの: `isolated-vm`、`vm2`、`oracledb`（ネイティブ）、`gm`（GraphicsMagick を `child_process` 起動）、`pg`/`mysql2`/`mssql`/`mongodb`/`redis`/`snowflake-sdk`/`amqplib`/`kafkajs`/`mqtt`/`ldapts`（生 TCP）、`chokidar`（`fs.watch`）、そして **`xlsx` は CDN の tarball を直接 URL 指定**しています。

公式 Dockerfile はマルチステージ構成で **builder ステージでネイティブアドオンをコンパイル**してから Alpine 3.24 ベースに移す作りです。イメージは 500MB 超（派生で 825.8MB の報告あり【第三者】）、RAM はアイドル 300–500MB・実行時 1–2GB スパイク、本番推奨 2 vCPU / 4GB。

### 2.3 データベース — v2 で 2 種類のみに削減【事実】

`packages/@n8n/config/src/configs/database.config.ts` の型 union は文字どおり **`'sqlite' | 'postgresdb'`**、既定 `'sqlite'`。**MySQL / MariaDB は型定義から消滅**しています。

- SQLite の実体は `~/.n8n/database.sqlite`
- **queue モードでは PostgreSQL 13+ が必須**（SQLite は非サポート）
- ORM は `@n8n/typeorm@0.6.0`（TypeORM の n8n フォーク）。エンティティ層は `@n8n/db`、**DB ドライバ自体は `packages/cli` が持つ**
- `DB_POSTGRESDB_POOL_SIZE` 既定 `2`、`DB_POSTGRESDB_STATEMENT_TIMEOUT` 既定 `300000`（5 分）

### 2.4 暗号鍵 — 設計上いちばん怖いところ【事実】

初回起動時に暗号鍵を自動生成し **`~/.n8n/config` に書き込みます**。このファイルが失われると**保存済み credential が全て復号不能**になります。`N8N_ENCRYPTION_KEY` env で明示指定すれば回避できます。

**Containers のディスクは ephemeral なので、これは「設定した方がよい」ではなく「設定しないと必ず壊れる」項目です。**

### 2.5 Binary data — S3 利用に Enterprise ライセンスの疑い ⚠️

現行は `packages/core/src/binary-data/` の `BinaryDataService`。モードは `'default'`（**メモリ内保持**。公式ドキュメントに *"This can cause crashes when working with large files"* と明記）/ `'filesystem'`（内部で `filesystem-v2` にマップ）/ `'s3'` / `'azure'` / `'database'`。

master には新パッケージ **`@n8n/blob-storage@1.1.0`** があり、その構成は `fs-byte-store.ts` / **`s3-byte-store.ee.ts`** / **`azure-byte-store.ee.ts`**。

**`.ee` サフィックスは Enterprise Edition を意味します。** つまり **R2（S3 互換）へのバイナリデータ外部化は Enterprise ライセンス機能である可能性が高い**。これは経路 A の設計を直撃します（§7.1 の PoC-1 と併せて確認が必要）。

なお **「n8n は queue モードで `filesystem` モードをサポートしない」**ため、queue モードを使うなら S3/Azure か database の二択になります。

### 2.6 Task Runners — Code ノードの実行基盤【事実】

Code ノードのユーザーコードは **n8n 本体から分離された別プロセス**で実行され、**WebSocket ブローカー**経由で通信します。

- **`internal` モード（既定）**: n8n が **`child_process` で runner を spawn**。公式は本番非推奨（uid/gid を共有するため）
- **`external` モード**: Go 製 `task-runner-launcher` が管理。実運用では `n8nio/runners` イメージをサイドカーで並走

**JS の実行は vm2 でも isolated-vm でもなく `node:vm`** です（`js-task-runner.ts` が `createContext` / `runInContext` を import）。子プロセスは `--disallow-code-generation-from-strings --disable-proto=delete` フラグ付きで起動されます。

**Python runner は Pyodide ではなくネイティブ CPython 3.13+** で、`multiprocessing` の `forkserver` による二重プロセス分離を行います。v2.0 から **external モードでのみ利用可能**になりました。

**含意**: Workers では `child_process` も `node:vm` もスタブのみなので、**Code ノードは Workers ネイティブでは現行実装のままでは動きません。** ただし §5.3 で述べるとおり Worker Loader が代替になりえます。

### 2.7 Webhook とスケジュール【事実】

**Webhook — Express との結合は意外に疎**

マウントは `packages/cli/src/abstract-server.ts` の 1 箇所に集約され、抽象化の要は **`IWebhookManager` インターフェース**（実装 4 種: `LiveWebhooks` / `TestWebhooks` / `WaitingWebhooks` / `WaitingForms`）。`WebhookRequestHandler` 自体は `req`/`res` 形状のオブジェクトを受けるだけです。

**Express 依存は `abstract-server.ts` と `webhook-request-handler.ts` の 2 ファイルに閉じています。** ただしその先の `webhook-helpers.ts`（**39,369 bytes**）は実行エンジン本体に直結します。

production webhook は **DB テーブル `webhook_entity`** に登録され、test webhook は `setTimeout` によるタイムアウト付きで 1 回受信すると消滅します。

**スケジュール — 2 世代が併存している【事実】**

*世代 1（現行デフォルト）*: `packages/core/src/execution-engine/scheduled-task-manager.ts` が npm の `cron` パッケージで `CronJob` を生成。**タイマーはプロセスメモリ上にのみ存在**するため、プロセスが死ぬと全消失します。multi-main 構成では leader だけが register します。

*世代 2 `@n8n/scheduler@1.2.0`（既定 OFF、`N8N_SCHEDULER_ENABLED=false`）*: **DB に先に書いてから実行する** durable scheduler。README の原文が設計思想を的確に述べています。

> Most schedulers keep their timers in memory... That is simple but fragile. If the process restarts, the timers are gone. ... This package takes a different approach: **write the work down before running it.**

job（ルール）と task（1 回の実行）を分け、Planner / Runner / Recovery / Cleanup の 4 パスで回します。**リーダー選出を行わず**、DB のアトミックな claim + lease + fencing（epoch）で調停します。**依存は `cron-parser` と `luxon` のみ**で、`src/__tests__/dependency-purity.test.ts` が `@n8n/db` / TypeORM / `n8n-core` / DI / `cli` / Node の I/O ビルトインの import を**機械的に禁止**しています。

**これは常駐プロセス前提を壊すために作られたパッケージであり、本プロジェクトと目的が完全に一致します。**

### 2.8 ★ n8n 自身が同じ方向へ動いている【事実】

master には **`@n8n/engine@0.13.0`** が存在します。README の原文:

> n8n workflow execution engine (v2). ... **Public API and core interfaces are still being defined; the package is currently a scaffold and is not yet wired into n8n.**

決定的なのは依存の少なさで、**`n8n-workflow` にも `n8n-core` にも依存していません**（README にも *"This package should not have runtime dependencies on other n8n components, only interfaces"* と明記）。**Postgres 専用**（`pg` のみ、sqlite ドライバなし）、**独自 Dockerfile を持つ独立デプロイ可能なサービス**です。

現在の実装レベルは HTTP ルート 1 本（`POST /`）、in-memory キュー 2 本、`'execution:enqueued'` 以外は `UnimplementedError`、**ノード実行ロジックは未実装**。設定コメントに *"This is in development and not ready for use."* とあり、**2026 年 7 月時点で本番利用不可**です。

**【推測】** 「永続化されたステップグラフ + ワークキュー」型の実行モデルで、現行の 95.6KB インメモリ再帰実行を DB 上のステップレコード + キュー駆動に置き換える方向。`admittance/`（受け入れ制御・バックプレッシャ）が最初から一級市民なのが特徴的です。

`@n8n/scheduler` の README には本プロジェクトに直結する記述もあります。

> ### Exploring the idea: a standalone `@n8n/scheduler-worker`
> ... **The result is far leaner than `cli`, which bundles every node's dependencies (1Password, S3, and more).**

**つまり `@n8n/engine` + `@n8n/scheduler` + `@n8n/blob-storage` の 3 つは、n8n 自身による「`packages/cli` 巨大依存の解体」プロジェクトです。本計画の経路 B は n8n 本家の進む方向と同じ側にあります。**

### 2.9 エディタ UI【事実】

`n8n-editor-ui@2.33.0` は **Vue 3 + Vite**、状態管理 Pinia、キャンバスは **Vue Flow**、エディタは CodeMirror、UI は Element Plus + `@n8n/design-system`、他に ag-grid と Chart.js。

静的配信は**可能**ですが、`VUE_APP_PUBLIC_PATH` に **`/{{BASE_PATH}}/` というプレースホルダ**が埋め込まれ、**配信時にサーバ側が文字列置換する**設計です（`n8n` の依存に `replacestream@4.0.3` があるのはこのため【推測】）。単純な静的ホスティングに載せるならこの置換を自前で行う必要があります。

**Push 通信は WebSocket と SSE の両対応**で、`N8N_PUSH_BACKEND` の既定は `websocket`。実装は `packages/cli/src/push/` にあり、**`sse.push.ts` はわずか 1,526 bytes**。

**これは移植上の朗報です。** Workers の `node:http` サーバ実装は `'upgrade'` イベント（= WebSocket アタッチ）に対応していないため、`N8N_PUSH_BACKEND=sse` に倒せる意味は大きい。

### 2.10 ★ n8n 自身がブラウザで `n8n-workflow` を使っている【事実】

`n8n-workflow@2.16.0` の dist に残るソースコメント:

> `@n8n/expression-runtime` is **Vite-stubbed for browser builds (to exclude isolated-vm)**, which prevents n8n-workflow from importing these extension utilities directly from the runtime package.

`@n8n/expression-runtime/dist/esm/index.js`:

> Bridge exports — IsolatedVmBridge **lazy-loads isolated-vm internally, so this value re-export does NOT pull in the native binary at import time.**

**n8n はすでに isolated-vm 抜きで `n8n-workflow` をフロントエンドに載せています。** §5.2 の実測結果はこの事実と整合します。

### 2.11 ライセンス

| 対象 | ライセンス |
|---|---|
| master の通常ファイル | **Sustainable Use License v1.0** |
| **`.ee.` / `.ee` を含むファイル・ディレクトリ** | **n8n Enterprise License**（別途契約） |
| master 以外のブランチ | **未ライセンス** |
| `@n8n/tournament` | **Apache-2.0** |

**Sustainable Use License v1.0 の要点**

- 許諾範囲は **「internal business purposes」または「non-commercial or personal use」**
- 再配布は**非商用かつ無償**でのみ可。商用ホスティング・SaaS 提供・第三者の便益のための提供は禁止
- **改変は可能。ただし改変した旨の目立つ通知（prominent notice）を含める義務**
- 伝播条項: 「あなたからソフトウェアの一部を受け取った者も同じ条項を受け取る」
- 違反で自動終了。通知から 30 日以内の是正で遡って回復、再違反は恒久終了

**Enterprise License（`LICENSE_EE.md`）**: 本番利用には有効な Enterprise ライセンスが必須。ただし ***"You may copy and modify the Software for development and testing purposes, without requiring a subscription."*** つまり開発・検証目的なら `.ee` コードも無償で触れます。

**Embed / OEM**: Embed License は**年額 $50K が基準線**、OEM は execution ベースの従量課金。

**本プロジェクトへの含意**

1. 個人利用の自己ホストは明確に許諾範囲内
2. **改変を伴うため、成果物に改変注記を含める義務がある**
3. **Cloudflare 上に n8n 互換サービスを立てて他者に提供することはできない**
4. **R2 へのバイナリデータ外部化は `.ee` の疑いがあり、本番利用には Enterprise ライセンスが要る可能性**（§2.5）

---

## 3. Cloudflare 側の事実

### 3.1 Workers の制限【事実】

| 項目 | Free | Paid |
|---|---|---|
| スクリプトサイズ（gzip 後） | 3 MB | **10 MB** |
| スクリプトサイズ（非圧縮） | 64 MB | 64 MB |
| **メモリ / isolate** | **128 MB** | **128 MB** |
| CPU 時間 / リクエスト | 10 ms | 30 秒（既定）／**最大 5 分**（`limits.cpu_ms` で明示オプトイン） |
| **Startup 時間** | **1 秒** | **1 秒** |
| サブリクエスト | 外部 50 | **10,000（既定）／最大 1,000 万** |
| 同時オープンコネクション | **6** | **6** |
| Cron Trigger / アカウント | 5 | 250 |
| Worker 数 / アカウント | 100 | 500 |

Startup 時間は **200ms →（2025-10-09 まで）400ms → 1 秒（2025-10-10 以降）** と緩和されてきました。超過時のエラーは **`10021`**（`Script startup exceeded CPU time limit`）、サイズ超過は **`10027`**。

**⚠️【第三者】startup 超過は再現性が低く厄介です。** 「依存のマイナーアップデートだけで突然壊れる」報告が繰り返されており（Zod v4 更新、SvelteKit 2.38.1→2.39.0 など）、**ローカルでは通るが本番デプロイで落ちる**ケースも複数あります。公式ですら *"プロファイルの overall startup time が実デプロイ時の値と正確に一致することは期待しないこと"* と注記しています。**CI に `wrangler check startup` を組み込むのが実務的防御です。**

Duration（実時間）: HTTP は**クライアント接続中は無制限** / Cron・DO Alarm・Queue Consumer は **15 分**。

### 3.2 Node.js 互換性の最新状況【事実】

`nodejs_compat` フラグ + 互換性日付 `2024-09-23` 以降が前提。一次ソースは workerd の `src/workerd/io/compatibility-date.capnp` です。

🟢 **完全サポート**: `assert` `async_hooks` `buffer` `crypto` `diagnostics_channel` `events` **`fs`** **`http`** **`https`** **`net`** `path` `process` `punycode` `querystring` `stream` `string_decoder` `timers` `url` `util` `zlib`

🟡 **部分サポート**: `console` `dns` `module` `os` `perf_hooks` `tls`

⛔ **非機能スタブ（import は通るが動かない）**: **`vm`** `cluster` **`child_process`** **`worker_threads`** `v8` `inspector` `repl` `readline` `tty` **`sqlite`** `dgram` `http2` `wasi` `domain` `trace_events`

公式ドキュメントの原文が明快です。

> **Stub modules allow package imports to succeed while providing non-functional implementations** — calling mocked methods will either do nothing or throw errors.

**依存が `require('child_process')` するだけで落ちるのを救済する措置であって、機能提供ではありません。** 2026 年時点でもプロセス起動・ワーカースレッド・ローカル SQLite は Workers 上で不可能です。

細かい注意点:
- `net` は 🟢 だが **`net.Server` は不可**（アウトバウンド `net.Socket` のみ）
- `tls` は `connect` / `TLSSocket` のみ。**`tls.createServer` は `Not implemented` を throw**
- `buffer` の非対応はメモリプーリングと `Buffer.allocUnsafe()`（常にゼロ埋め）の 2 点のみ

**⚠️ `enable_nodejs_fs_module` の既定日は capnp が `2025-09-15`、docs が `2025-09-01` で食い違います。安全側に 2025-09-15 以降を採るべきです。**

### 3.3 `node:fs` の実体 — 仮想ファイルシステム【事実】

`fs` が 🟢 になったのは朗報ですが、実体は **VFS（仮想メモリファイルシステム）**です。

| パス | 性質 |
|---|---|
| `/bundle` | **読み取り専用**。Worker バンドル同梱ファイル |
| `/tmp` | 書き込み可。ただし **リクエストごとに独立、リクエスト間で永続も共有もしない** |
| `/dev` | `null` / `random` / `full` / `zero` |

- **全操作が同期実行**（async API でも内部は同期）
- 単一ファイル最大 128 MB / パス長 4,096 文字 / セグメント 48
- **`/tmp` は Worker のメモリ制限 128MB を消費**（超過で isolate 終了）
- 非対応: `fs.watch` / `fs.watchFile` / `fs.glob` / `fs.rm` の `force` / パーミッション / **タイムスタンプは常に Unix epoch**

DO 内では同一 DO インスタンス内のリクエスト間で共有できますが、**Worker 再起動・デプロイをまたいで永続はしません。**

### 3.4 ★ 2026 年の最大の変化 — `node:http` サーバ【事実】

2025-09-08 に **Express が Workers 上で動くようになりました。**

```js
import { httpServerHandler } from "cloudflare:node";
import { createServer } from "node:http";
const server = createServer(app);   // app = Express
server.listen(8080);
export default httpServerHandler({ port: 8080 });
```

port は実ネットワークバインドではなく**ルーティングキー**です。公式に **Express.js と Koa.js をサポート**と明記されています。

**しかし動かないものが Express モノリスに直撃します。**

| 非対応 | 影響 |
|---|---|
| **`'upgrade'` イベント / connection upgrades** | **WebSocket アタッチ（`ws` / socket.io）が不可** |
| socket アクセス / `'socket'` イベント | 生ソケット操作 |
| `Agent` は stub | コネクションプーリング・keep-alive |
| `closeAllConnections()` 等 | graceful shutdown |

**【推測】** ルーティング層はほぼそのまま動くが、**WebSocket・生ソケット・コネクションプールに触るコードは全部書き直し**になります。n8n の push backend が既定 `websocket` なのはここに刺さりますが、**SSE 実装が存在する**ので回避できます（§2.9）。

### 3.5 ★ eval / `new Function` の禁止【事実】

**これが本調査で判明した最も重要な制約です。**

| フラグ | 既定日 | 挙動 |
|---|---|---|
| `allow_eval_during_startup` | 2025-06-01 | **起動時（グローバルスコープ実行中）に限り** `eval` / `new Function` 許可 |
| `allow_insecure_inefficient_logged_eval` | experimental 専用 | 常時許可。capnp に *"should never be enabled by default"*。**本番不可** |

**リクエスト処理中は禁止**され、`EvalError: Code generation from strings disallowed for this context` になります。**本番の Cloudflare ネットワーク上で eval を有効化する方法はありません**（ローカル workerd には `UnsafeEval` バインディングがあります）。

被害報告は多数あり、MCP の AJV、`js-sha256@0.9.0`、tough-cookie などが該当します。**Wrangler 4.16 が eval チェックを導入して既存ライブラリが壊れた**という Issue もあります。

**想定解は Dynamic Workers / Worker Loader バインディング**です。

### 3.6 動的 `import()` / `require()`【事実】

公式明言:

> variable based dynamic imports (for example, `await import(\`./lang/${language}.mjs\`)`) would **always fail at runtime** because Wrangler had no way of knowing which modules to include

- `require()` は動作（CJS 対応済み。ただし top-level await 併用不可）
- **動的 `import()` はビルド時に静的解析可能な場合のみ**
- 回避策は `find_additional_modules: true` + `rules` で事前列挙

**【推測・n8n に直撃】** プラグインアーキテクチャ（`require(path.join(pluginDir, name))`）は**原理的に成立しません**。**n8n の `LazyPackageDirectoryLoader` はまさにこのパターン**で、静的バンドルと最悪の相性です。community node の実行時 npm install も同様に不可能です。

### 3.7 グローバル state と I/O オブジェクト【事実】

公式:

> ...**do not use or mutate global state**. ... global variables set during one request may or may not exist during the next

頻出エラー:

```
Cannot perform I/O on behalf of a different request. I/O objects (such as streams,
request/response bodies, and others) created in the context of one request handler
cannot be accessed from a different request's handler.
```

**最頻の原因は「グローバルスコープに DB コネクション / Request / Response をキャッシュ」**すること。対策は **I/O オブジェクトではなくデータだけ**をグローバルに置くことです。

さらに:

```
Some functionality, such as asynchronous I/O, timeouts, and generating random values,
can only be performed while handling a request.
```

**モジュールのトップレベルで「DB 接続確立」「設定を fetch」「暗号鍵を生成」する典型的な Express 起動シーケンスは全部書き直しが必要です。**

### 3.8 タイマーの重大な注意点【事実】

> timers are limited to returning the time of the last I/O. ... **they will not delay them for the full time specified.**

**時計はセキュリティ上「最後の I/O 時点」で止まっています。** 本番で関数の実行時間を測ることも困難と公式が明記しています。代替は Cron Triggers（最短 1 分【推測】）と DO alarms です。

### 3.9 Durable Objects【事実】

**2026-07-09 に KV バックエンド namespace の新規作成が制限**されました。**2026 年の新規プロジェクトは SQLite バックエンド一択**で、`new_sqlite_classes` マイグレーションが必須です。

| 項目 | 値 |
|---|---|
| Storage / DO | **10 GB**（Free は 1 GB/object） |
| CPU / request | 30 秒（既定）／5 分まで |
| **Requests / Object** | ソフトリミット **1,000 req/秒** |
| Key + Value 合計 | 2 MB |
| WebSocket メッセージ | 32 MiB（受信のみ） |
| Alarm handler wall time | **15 分** |
| DO クラス数 / アカウント | 500（Paid） |
| オブジェクト実体数 | 無制限 |

SQL 制限は D1 と同一（カラム 100 / 行 2MB / ステートメント 100KB / バインド 100）。

**WebSocket Hibernation API**: `state.acceptWebSocket(ws, tags?)` を使う（`ws.accept()` **ではない**）。`ws.serializeAttachment(value)` がハイバネーションを跨いで生き残る（**最大 16,384 bytes**）。**ハイバネーション中は in-memory state がリセットされ、メッセージ受信時にコンストラクタが再実行**されます。最大 **32,768 WebSocket/DO**。**ハイバネーション適格な DO は duration 課金が停止**します。公式のコスト例では 100 オブジェクト × 各 100 接続で **ハイバネーション利用 月約 $10、未利用 $138+**。

**Alarms**: **1 オブジェクトにつき 1 つのみ**。**at-least-once 保証**で、throw すると初回失敗から 2 秒ディレイの指数バックオフで最大 6 回リトライ。**ハイバネーション後はコンストラクタが alarm ハンドラより先に実行**されるため、コンストラクタ内で無条件に `setAlarm()` を呼ぶと干渉します。

### 3.10 D1【事実】

| 項目 | Free | Paid |
|---|---|---|
| **最大 DB サイズ** | 500 MB | **10 GB（引き上げ不可）** |
| アカウント合計 | 5 GB | 1 TB |
| Worker 1 起動あたりクエリ数 | 50 | 1,000 |
| 最大 SQL ステートメント長 | 100 KB | 100 KB |
| クエリあたりバインドパラメータ | 100 | 100 |
| 最大クエリ実行時間 | 30 秒 | 30 秒 |

**★ 最重要の性能特性【事実】**

> Each individual D1 database is inherently **single-threaded**, and processes queries one at a time.

**DB 単位でシングルスレッド**です。1ms クエリで約 1,000 QPS ですが、**100ms クエリなら約 10 QPS** しか出ません。

課金は **rows read が「スキャンした行数」**（フルテーブルスキャンは返却行でなくスキャン全行が課金対象）、**インデックス列への書き込みは追加で 1 行分**。egress 課金はなし。

**【推測・確度高】インタラクティブトランザクションは 2026-07 時点で非対応**（`batch()` による暗黙トランザクションのみ）。**⚠️ read replication は 2026-07 時点で GA アナウンスを確認できず、public beta の可能性が高い。**

### 3.11 Cloudflare Workflows【事実】

**2025-04-07 GA**。Free/Paid 両方で利用可能。

| 項目 | Free | Paid |
|---|---|---|
| ステップあたり CPU 時間 | 10 ms | 30 秒（既定）／最大 5 分 |
| **ステップあたり wall time** | **無制限** | **無制限** |
| ステップ結果サイズ | 1 MiB | 1 MiB |
| **最大ステップ数** | 1,024 | **10,000（既定）／25,000** |
| **`step.sleep` 最大** | **365 日** | **365 日** |
| 同時実行インスタンス | 100 | **50,000** |
| ステート保持 | 3 日 | 30 日 |

**待機中（sleep / waitForEvent）のインスタンスは同時実行数にカウントされません。** リトライ既定は `{ limit: 5, delay: 10000, backoff: "exponential" }`、`timeout` は**リトライ試行ごと**に適用。`step.waitForEvent` で human-in-the-loop が組めます。

**課金は CPU 時間ベース**で、*"API 応答待ち・`step.sleep` 中・アイドル中は CPU time が発生しない"* — これが最大の経済的利点です。Storage 課金開始は 2026-08-10。

### 3.12 Cloudflare Containers — GA（2026-04-13）【事実】

Container は **Durable Object に紐づき**、`Container` クラスは `DurableObject` を継承します。ルーティングは `Client → Worker → Durable Object → Container instance`。

**⚠️ 重要**: *"DO とそれに紐づく Container インスタンスは同じロケーションで動く保証はない"* — 配置は DO との同居より**起動速度**を優先します。

**インスタンスタイプ**

| タイプ | vCPU | メモリ | ディスク |
|---|---|---|---|
| `lite`（既定・旧 `dev`） | 1/16 | 256 MiB | 2 GB |
| `basic` | 1/4 | 1 GiB | 4 GB |
| `standard-1`（旧 `standard`） | 1/2 | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

カスタムは vCPU 1〜4、メモリ最大 12 GiB、ディスク最大 20 GB、**最低 3 GiB メモリ/vCPU**、**最大 2 GB disk/1 GiB メモリ**。アカウント上限は同時メモリ 6 TiB / vCPU 1,500 / ディスク 30 TB / **総イメージストレージ 50 GB**。`max_instances` 既定 20。

**★ ストレージ — 完全に ephemeral【事実】**

公式 FAQ の原文:

> **All disk is ephemeral.** When a Container instance goes to sleep, the next time it is started, it will have a fresh disk as defined by its container image.

- **Snapshots は "coming soon"**（Sandbox SDK には実装済み）
- **永続ボリュームマウントは提供されていない**
- 永続化の選択肢は ① DO の SQLite ストレージ ② **R2 の FUSE マウント**（2025-11-21 追加、`tigrisfs` で `/mnt/r2`。ただし公式が *"you should not expect native SSD-like performance"* と警告）③ アウトバウンドハンドラ経由の KV/R2/D1/DO

**【推測】SQLite を FUSE 経由の R2 に置くのは、SQLite のロック / fsync セマンティクス的に破綻する可能性が非常に高い。**

**コールドスタート・スリープ【事実】**

- コールドスタートは **1〜3 秒の範囲であることが多い**
- `sleepAfter` 既定 **`"10m"`**
- シャットダウンは **SIGTERM → 15 分後に SIGKILL**
- **Cloudflare 側が特定時間で強制停止することはない**。ただしホスト再起動は "happens irregularly"
- **OOM 時はエラーを throw して再起動。swap は使わない**
- **組み込みオートスケーリングは未提供**。`getRandom(binding, N)` は固定 N 台へのランダム分散のみで**ロケーションを考慮しない**

**ネットワーキング【事実】**

- 外向きインターネットは既定で有効（`enableInternet = true`）
- **コンテナ → Workers バインディング**: 仮想ホスト名へ普通の HTTP（例 `http://my.kv/some-key`）でアクセスでき、**コンテナ内に SDK 不要**
- WebSocket は `Container.fetch` が**自動転送**（`containerFetch` は非対応）
- 生 TCP は `ctx.container.getTcpPort(port).connect()`
- **公開 IP は割り当てられず、必ず Worker（DO）経由**【推測・確度高】

**⚠️★ 最重要の未検証事項 — アウトバウンド生 TCP**

ソース間で矛盾しています。

- FAQ: アウトバウンド可能、ポート制限の記述なし
- outbound-traffic docs: *"Outbound handlers only intercept HTTP and HTTPS traffic. **Traffic on ports other than `80` and `443` is never routed through `outbound` or `outboundByHost`.**"*
- `cloudflare/containers` の egress.md: 制御軸は `enableInternet` / ホスト名 glob / ハンドラのみで、**ポート単位の制御という概念が存在しない**

**【推測】** 素直に読めば「80/443 以外は**インターセプトされない**」であって「ブロックされる」とは書いていません。生 TCP は素通しで出られるが outbound Worker の制御対象外、と読めます。**ただし推測に本計画を賭けることはできません。PoC-1 で最初に潰します。**

**料金【事実】**

| リソース | Workers Paid 込み | 超過レート |
|---|---|---|
| メモリ | 25 GiB-時/月 | $0.0000025 / GiB-秒 |
| CPU | 375 vCPU-分/月 | $0.000020 / vCPU-秒 |
| ディスク | 200 GB-時/月 | $0.00000007 / GB-秒 |
| egress（北米・欧州） | 1 TB/月 | $0.025 / GB |

**CPU 課金はアクティブ使用時のみ**（Active CPU Pricing、2025-11-21 導入）ですが、**メモリとディスクは provisioned 量に対して課金**されます。

**【推測】`standard-1` を 24/7 常時起動した場合**: メモリ 4 GiB × 2,592,000s × $0.0000025 ≈ **$25.9/月** + ディスク 8 GB × 2,592,000s × $0.00000007 ≈ **$1.45/月** = **月 $27〜30**（無料枠差引前、Workers/DO 課金別）。**同スペックの VPS より高い。**

**Sandbox SDK**（Containers と同時に 2026-04-13 GA）は上位抽象で、**スナップショット**（`createBackup()` / `restoreBackup()`）、PTY ターミナル、バックグラウンドプロセス + プレビュー URL、R2/S3 バケットマウントを提供します。素の Containers に無い永続化手段があるため、経路 A では検討に値します。

### 3.13 その他の周辺サービス【事実】

**R2**: Storage $0.015/GB-月、**egress 無料**、最大オブジェクト 5 TiB、単一 PUT 上限 5 GiB、**同一キーへの同時書き込み 1/秒**。

**Hyperdrive**: PostgreSQL と MySQL に対応。**外部 Postgres 接続に必須ではなく**、`cloudflare:sockets` の `connect()` で直接 TCP 接続も可能。最大クエリ実行時間 60 秒、最大キャッシュレスポンス 50 MB、**Hyperdrive 自体は追加料金なし**。**⚠️ Hyperdrive のドキュメントは Workers 統合のみを扱い、Containers からの利用には言及がありません。**

**Workers Static Assets**: ファイル数 Paid 100,000、個別 25 MiB。**★ *"Requests to static assets are free and unlimited."*** — アセットのリクエストもストレージも**完全に無課金**です。**【推測】** 個別ファイル 25 MiB が Free の 3MB バンドル上限を超えることから、アセットはバンドルサイズにカウントされないと判断してよい。**エディタ UI の配信先として理想的です。**

**Queues**: メッセージ 128 KB、per-queue 5,000 msg/秒、consumer duration 15 分、$0.40/100 万 operations（1 メッセージ配信 = 通常 3 operations）。

---

## 4. ★ 実測結果 — `n8n-workflow` は workerd で動く

再現用ファイル一式を **`experiments/workerd-n8n-workflow/`** に保全しました。詳細は同ディレクトリの `README.md` を参照してください。

環境: `wrangler 4.115.0` + workerd（ローカル）、`compatibility_date: 2025-09-01`、`compatibility_flags: ["nodejs_compat"]`、`n8n-workflow@2.16.0`

### 4.1 バンドルサイズ — 成功【実測】

esbuild で `--conditions=workerd,worker,browser,import`、Node 組み込みを external、`isolated-vm` / `node-gyp-build` をスタブ置換:

```
BUILD OK
out.js  3,185,891 bytes (raw)  /  570,053 bytes (gzip)
```

**Paid の 10 MB gzip 上限に対して 5.7%。Free の 3 MB でも余裕で収まります。**

### 4.2 workerd 上でのロードと Workflow 構築 — 成功【実測】

```json
{"Workflow":"function","jsonParse":"function","main":"main","NodeHelpers":"object"}
{"workflowConstructed": true, "nodeNames": ["Start"], "exprType": "object"}
```

**`new Workflow({...})` が workerd 上で正常に構築できました。**

### 4.3 式評価で破綻 — これが真の壁【実測】

```
EvalError: Code generation from strings disallowed for this context
  at new Function (<anonymous>)
  at FunctionEvaluator.getFunction   (@n8n/tournament)
  at FunctionEvaluator.evaluate      (@n8n/tournament)
  at Tournament.execute
```

`Expression.getActiveImplementation()` は **`"legacy"`** を返します。n8n の式エンジンには `legacy` と `vm` の 2 実装があり（env `N8N_EXPRESSION_ENGINE`）、**既定の `legacy` は isolated-vm を必要としません**。しかしその `legacy` が `@n8n/tournament` の `FunctionEvaluator` 内で **`new Function(...)` を使います**。

**つまり Workers 上での n8n 式評価のブロッカーは「isolated-vm（ネイティブアドオン）」ではなく「`new Function`（ランタイムポリシー）」です。この区別は Web 上のどの記事にも書かれていません。**

### 4.4 回避策の検証【実測】

**`unsafe_eval` バインディング → ローカルでは使えない。** wrangler が `remote` と表示し、`env.UNSAFE_EVAL === undefined`。`"unsafe" fields are experimental` の警告も出ます。

**Worker Loader バインディング → 成功。**

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

```js
const w = await env.LOADER.get('expr-1', async () => ({
  compatibilityDate: '2025-09-01', mainModule: 'main.js',
  modules: { 'main.js': `export default { async fetch(){ ... } }` },
  globalOutbound: null,
}));
```

結果: `{"hasLoader": true, "dynamicResult": "3"}` — **ローカル workerd で動的コード実行に成功しました。**

### 4.5 この実測から導かれること

**【推測・確度高】** `@n8n/tournament` の `FunctionEvaluator` を Worker Loader ベースに差し替えれば、**n8n の式評価は Workers 上で動かせる見込みがあります。** 同じ仕組みで **Code ノードの JS 実行も Task Runner の代替として実装可能**で、`globalOutbound` による egress 制御ができる分、**むしろ n8n の external task runner より綺麗にサンドボックス化できます。**

**残る課題**: `new Function` は同期、Worker Loader は非同期です。tournament の同期 API を非同期化する改造が必要になります。これが PoC-2 の核心です。

---

## 5. 突き合わせ

### 5.1 なぜ Workers 単体で n8n 本体が動かないか

| # | ブロッカー | 詳細 |
|---|---|---|
| 1 | **バンドルサイズ** | n8n は数百 MB〜1GB。gzip 10MB 上限に対し **2 桁違い**。動的 require は静的バンドルと最悪の相性 |
| 2 | **メモリ 128MB** | n8n はアイドルで 300–500MB |
| 3 | **`child_process` スタブ** | internal mode の Task Runner が起動不能 |
| 4 | **`node:vm` スタブ** | Code ノードのサンドボックスが動作不能 |
| 5 | **`'upgrade'` 非対応** | Express の listen は 2025-09 に解決したが **push backend の WebSocket が死ぬ**（SSE で回避可） |
| 6 | **実行時 npm install 不可** | community node が入らない |
| 7 | **SQLite 不可 + 永続 FS 無し** | `node:sqlite` はスタブ、`/tmp` は揮発 |

**単体なら回避策を積めるものもありますが、1・2 は回避不能です。**

### 5.2 経路 A（Containers）の急所

| n8n の要求 | Containers の現実 | 対処 |
|---|---|---|
| 永続ディスク（`~/.n8n`、SQLite） | **完全に ephemeral**【事実】 | **外部 PostgreSQL 必須**。Cloudflare はマネージド Postgres を提供していない（D1 も Hyperdrive も代替にならない） |
| 暗号鍵の自動生成 | ディスク揮発で毎回変わる | **`N8N_ENCRYPTION_KEY` を env で固定必須** |
| バイナリデータのファイル保存 | 同上 | R2（S3 互換）へ。**ただし `.ee` の疑い**（§2.5） |
| Postgres への TCP 接続 | **⚠️ 可否が未確認** | **PoC-1** |
| Schedule Trigger の常時稼働 | `sleepAfter` で寝ると発火しない | Worker Cron Trigger で起こす、または常時起動 |
| community node の npm install | ディスク揮発で消える | **`N8N_COMMUNITY_PACKAGES_ENABLED=false`**、必要なノードはイメージに焼き込む |
| WebSocket push | `Container.fetch` が自動転送【事実】 | 動くはず。ただし SSE の方が単純 |
| `child_process`（Task Runner） | **普通の Linux なので問題なし** | — |

**コスト**: `standard-1` 24/7 で月 $27〜30。**n8n は「永続ディスクが要る・常時起動が要る・always-on」という、Containers が最も苦手とする形です。**

### 5.3 経路 B（Workers ネイティブ）の現実的な射程

**使える資産【実測 + 事実】**

1. **`n8n-workflow`** — ネイティブ依存ゼロ、570KB gzip、workerd 動作実証済み
2. **`@n8n/workflow-sdk@0.26.0`** — ワークフロー JSON の生成 SDK。ネイティブ依存ゼロ
3. **declarative-style ノードの description** — `operations` の `routing` キーで API 呼び出しを宣言する形式。**【推測】** 実質「HTTP リクエスト定義の JSON」なので、`nodes-base` のネイティブ依存を引かずに **description だけ取り出して汎用 fetch ランナーで実行できる**。400+ ノードのうち相当数がこの形式で、エッジ移植の現実的な足がかりになります
4. **SSE push 実装**（1,526 bytes）
5. **`@n8n/tournament`（Apache-2.0）** — ライセンス的にいちばん自由に改変できる

**捨てるもの**: `n8n-core`（`@sentry/node-native` 等）、`n8n-nodes-base` 全体、`packages/cli`。

**Cloudflare 側の受け皿**

| n8n の要素 | Cloudflare の対応物 |
|---|---|
| ワークフロー定義・実行履歴 | **D1**（ただし DB 単位シングルスレッド） |
| 1 実行のステート | **Durable Object**（SQLite バックエンド、10 GB、CPU 最大 5 分） |
| 長時間・多ステップ実行 | **Cloudflare Workflows**（sleep 365 日、wall time 無制限、CPU 課金のみ） |
| バイナリデータ | **R2**（egress 無料） |
| 式評価・Code ノード | **Worker Loader**【実測で動作確認】 |
| スケジュール | **Cron Triggers**（Paid 250）+ DO Alarms |
| エディタ UI | **Workers Static Assets**（**リクエスト・ストレージとも完全無料**） |

### 5.4 先行事例【事実 / 第三者】

- **n8n 本体を Workers/Containers で動かした公開事例はゼロ件。** 独立した 2 系統の検索で同じ negative result
- **Stackbilt-dev/n8n-transpiler**（Apache-2.0）— **唯一の本命に近い試み**。n8n を動かすのではなく **workflow JSON を CF Workers 用 TypeScript にトランスパイル**する。webhook / schedule / HTTP Request / IF / Switch / splitInBatches / Postgres・MySQL（Hyperdrive 経由）/ Workers AI に対応、Code ノードはスタブのみ。**commits 7、★0、リリースなし**
- **Dafthunk**（MIT、★113、2,389 commits）— **唯一の「Cloudflare ネイティブな n8n 代替」**。CF Workers + Workflows + D1 + R2 + KV + Workers AI + Queues / Hono + Drizzle / React 19 + React Flow。50+ ノードタイプ、アイドル時 scale-to-zero。**経路 B が成立することの実在する証明**
- **Cloudflare Dynamic Workflows**（2026-05、**MIT**）— テナント/リクエストごとに異なるワークフローコードを実行。**「ユーザーごとに違うワークフロー」を CF 上で実現する公式の答え**
- **Cloudflare MoltWorker**（2026-02）— Worker をルータ、実体は Sandbox コンテナ、状態は R2、認証は Zero Trust Access。**経路 A の雛形**。ただし Cloudflare 自身が「プロダクトではなく PoC」と位置づけ

**最も雄弁な傍証【第三者】**: Dafthunk が自サイトで *"n8n is built around a long-running Node.js process and relies on a SQL database you provision yourself. **Dafthunk was built for Cloudflare from day one.**"* と述べています。**Cloudflare で n8n 相当をやる人は、移植せずゼロから書き直しています。**

**他の大規模フレームワークの記録**: Strapi は **公式が明確に拒否**（*"we do not plan to support deploying Strapi on serverless environments"*）。socket.io はメンテナ本人が「公式機能化は困難」と回答し、**Cloudflare の WebSocket サーバをベースにした custom engine を作れ**と推奨しています。

---

## 6. 推奨方針

### 6.1 まず PoC を 2 本、並行で走らせる

方針を先に決めてから検証するのではなく、**方針を決める権利を PoC の結果に委ねます。** どちらも数日で結論が出ます。

**PoC-1 — Container からの生 TCP アウトバウンド ⚠️最優先**

`lite` インスタンスに小さな Node スクリプトを載せ、外部 PostgreSQL（Neon 無料枠）の 5432 へ `pg` で接続し `SELECT 1` を返すだけのものをデプロイします。

- **成功** → 経路 A が成立。リファレンス環境として Phase A へ
- **失敗** → 経路 A は全滅。Hyperdrive が Containers から使えるかを次に確認し、それも駄目なら**経路 B 一本に絞る**

**PoC-2 — Worker Loader による式評価**

`experiments/workerd-n8n-workflow/` を出発点に、`@n8n/tournament` の `FunctionEvaluator` を Worker Loader ベースに差し替え、`={{ 1 + 2 }}` と `={{ $now.year }}` と拡張関数 `={{ "hello world".toSnakeCase() }}` を通します。

- 焦点は **同期 API の非同期化**をどこまで局所的に済ませられるか
- **`@n8n/tournament` は Apache-2.0** なのでフォークしても License 上いちばん安全
- **成功** → 経路 B の最大の技術的不確実性が消える
- **失敗** → 式評価を自前実装するか、式を含まないワークフローに限定するかの判断へ

### 6.2 PoC の結果を待たずに言えること

**最終的に目指すべきは経路 B です。** 理由は 4 つあります。

第一に、**経路 A は Cloudflare である必然性がありません。** 月 $27〜30 で ephemeral disk・外部 Postgres 必須・オートスケーリングなし・cold start 1〜3 秒という条件は、同額の VPS に Docker で n8n を立てる方が素直に優れています。「Cloudflare で動かす」という本プロジェクトの目的に対して、経路 A は「Cloudflare 上のコンテナホスティング」でしかありません。

第二に、**経路 B の最大の不確実性は実測で既に半分解けています。** バンドルは 570KB で収まり、`Workflow` は構築でき、動的コード実行の代替手段も動きました。残るのは「同期 API の非同期化」という、規模は読めるが性質は明確な作業です。

第三に、**n8n 本家が同じ方向へ動いています。** `@n8n/engine`（`n8n-workflow` にも `n8n-core` にも依存しない、Postgres 専用、キュー駆動、独立デプロイ可能）と `@n8n/scheduler`（DB 永続・リーダーレス・純粋ロジック）は、まさに `packages/cli` の巨大依存を解体するためのものです。経路 B はこの流れに逆らわずに済みます。

第四に、**Dafthunk が経路 B の成立を証明しています。** ゼロから書けば Cloudflare 上でワークフロー自動化基盤は成立します。本プロジェクトの差別化は「**n8n のワークフロー JSON をそのまま受け取れること**」に置けます。

**ただし経路 A には固有の価値があります。** それは「n8n 本家の実行結果を正解データとして取れること」です。経路 B のノード実装が本家と同じ出力を返すかを機械的に検証できる環境は、互換性を売りにする以上どうしても要ります。**したがって経路 A は「本番」ではなく「リファレンス環境 / 適合性テストの基準」として位置づけます。**

### 6.3 目指す最終形

```
                    ┌──────────────────────────────┐
   ブラウザ ────────▶│ Worker（ルータ + 認証）        │
                    │ Static Assets でエディタ UI 配信 │
                    └───┬──────────────────────┬───┘
                        │                      │
          対応ノードのみ  │                      │ 非対応ノードを含む
                        ▼                      ▼
        ┌───────────────────────────┐   ┌──────────────────┐
        │ Workers ネイティブ実行       │   │ Container の n8n   │
        │ ・n8n-workflow (570KB)     │   │ （sleepAfter で   │
        │ ・Worker Loader で式/Code   │   │   普段は寝ている） │
        │ ・DO で 1実行 = 1オブジェクト │   │  = リファレンス   │
        │ ・Workflows で長時間実行     │   └──────────────────┘
        └───────────────────────────┘
                        │
          D1（定義・履歴） / R2（バイナリ） / Cron Triggers
```

---

## 7. ロードマップ

### Phase 0 — 足場と PoC（最優先）

1. Workers Paid プラン有効化（Containers は Paid 必須）
2. `wrangler.jsonc` でプロジェクト初期化。**新規は jsonc 一択**（公式が「新しい機能は JSON 設定でのみ提供される」と明言）。`compatibility_date` は 2025-09-15 以降、`nodejs_compat` 有効化
3. **PoC-1**（Container → 外部 Postgres:5432 の生 TCP）
4. **PoC-2**（Worker Loader 版 `FunctionEvaluator`）
5. **ライセンス対応**: Sustainable Use License の写しと**改変注記**をリポジトリに配置。`.ee` 由来コードには触れない方針を明文化
6. CI に **`wrangler check startup`** を組み込む（§3.1 の非決定的 startup 超過への防御）

**Phase 0 の完了条件**: PoC-1 と PoC-2 の結果が出て、経路 A を作るか否かが決まっていること。

### Phase A — Containers でリファレンス環境を立てる（PoC-1 成功時のみ）

1. `n8nio/n8n` 公式イメージをベースにした Dockerfile（ネイティブアドオンのビルド済みイメージを使い、自前ビルドは避ける）。**`--platform linux/amd64` を明示**（⚠️ 対応アーキテクチャは公式に明示がなく、amd64 前提が安全）
2. `wrangler.jsonc` に `containers` / `durable_objects` / `migrations`（`new_sqlite_classes`）を定義。`instance_type` は `standard-1` から
3. `Container` サブクラス（`defaultPort = 5678`、`sleepAfter`、`envVars`）
4. 永続層の外部化
   - `DB_TYPE=postgresdb` + 外部 PostgreSQL（Neon 無料枠）
   - **`N8N_ENCRYPTION_KEY` を Wrangler Secret で固定**（最重要）
   - `N8N_DEFAULT_BINARY_DATA_MODE` → R2。**⚠️ Enterprise ライセンス要否を確認**（§2.5）。要るなら `database` モードで代替
   - **`N8N_COMMUNITY_PACKAGES_ENABLED=false`**
   - **`N8N_PUSH_BACKEND=sse`**（WebSocket より単純）
5. Worker 側で `getByName` により**単一インスタンスに固定**（n8n はステートフルなのでロードバランスしてはいけない）
6. Cloudflare Access で管理 UI を保護
7. **Worker Cron Trigger でコンテナを起こす**（`sleepAfter` 中は Schedule Trigger が発火しない）
8. 1 週間運用してメモリ・CPU・ディスクの実消費を計測し instance_type を見直す

**Phase A の完了条件**: エディタが開き、ワークフローを保存でき、コンテナ再起動後も消えず、Webhook とスケジュールの両方が発火すること。

### Phase B-1 — 式評価とワークフロー実行の最小 PoC

1. PoC-2 の成果を `@n8n/tournament` のフォークとして整理（Apache-2.0）
2. `n8n-workflow` の `Workflow` クラスで最小ワークフロー（Manual Trigger → Set → HTTP Request）を Worker 上で実行
3. **バンドルサイズと startup 時間を毎回計測**。570KB gzip / 1 秒 startup の余裕がどこで食い潰されるかを追う
4. D1 にワークフロー定義を保存し、**n8n 本家のエクスポート JSON をそのままインポート**できるようにする

**⚠️ 撤退ライン**: startup が 1 秒に収まらない、またはバンドルが Paid の 10MB を超える見込みが立った時点で、`n8n-workflow` 全体の取り込みを諦め、式評価（tournament）とワークフロー JSON の型定義のみを借りて実行グラフの走査を自前で書く方向へ切り替えます。

### Phase B-2 — ステート管理とノードサブセット

1. **1 実行 = 1 Durable Object**（SQLite バックエンド）で実行状態を保持
2. 長時間・多ステップ実行は **Cloudflare Workflows** に載せ、リトライと sleep を基盤へ委譲（**ステップ結果は 1 MiB 上限**に注意）
3. ノード実装の優先順位: Webhook / Schedule / HTTP Request / Set / IF / Switch / Merge / Split In Batches
4. **declarative-style ノードの description を汎用 fetch ランナーで実行する仕組み**を作る（§5.3）。ここが対応ノード数を一気に伸ばす鍵
5. Code ノードは **Worker Loader** で実装（`globalOutbound` で egress 制御）
6. バイナリデータは R2。`node:fs` の VFS は**中間バッファとしてのみ**使う
7. **同時アウトバウンド接続 6** の制約に合わせて並列度を絞る
8. エディタ UI は **Workers Static Assets**（無課金）で配信。n8n の `frontend` をそのまま使うなら **`/{{BASE_PATH}}/` の置換**を自前で行う

### Phase C — 振り分け

1. ワークフロー JSON を静的解析し、含まれるノード型が Worker ネイティブ実装のカバー範囲に収まるか判定
2. 収まる → Worker で実行 / 収まらない → Container の n8n に委譲
3. Phase A の環境を**適合性テストの基準**として使い、同じワークフローの実行結果を両者で突き合わせる回帰テストを整備

---

## 8. リスク

**設計上のリスク**

- **`N8N_ENCRYPTION_KEY` の管理ミスは credential の全損に直結。** Phase 0 で Wrangler Secret に固定し、別途バックアップを取ること
- **D1 は DB 単位でシングルスレッド。** 重いクエリを書くと 10 QPS まで落ちます。個人利用では問題になりませんが、スキーマ設計時に意識が要ります
- **DO は 1 オブジェクトあたり 1,000 req/秒のソフト上限。** Phase A の単一コンテナ集約構成では上限になりえます
- **同時アウトバウンド接続 6。** 多数の HTTP Request ノードを並列実行するワークフローで効きます
- **startup 1 秒超過は非決定的に起きる。** 依存のマイナーアップデートで突然壊れた報告が複数あります。CI での計測が必須
- **グローバルスコープでの I/O 禁止。** DB クライアントをグローバルにキャッシュする典型パターンが `Cannot perform I/O on behalf of a different request` を引き起こします

**ライセンスのリスク**

- **この成果物を第三者にホスティングサービスとして提供することはできません**（Sustainable Use License）
- **改変注記の記載義務**があります
- **R2 へのバイナリデータ外部化は `.ee`（Enterprise）の疑い。** 開発・テスト目的なら無償で触れますが、本番利用には Enterprise ライセンスが必要になる可能性があります

**プロジェクト運営上のリスク**

- **n8n 本家が `@n8n/engine` で実行モデルを書き換えている最中です。** 経路 B が現行 `n8n-workflow` の API に深く依存すると、v2 エンジンの完成時に作り直しになる可能性があります。**依存面を薄く保ち、ワークフロー JSON という安定した境界に賭けるべきです**

---

## 9. 未確認事項（優先度順）

1. **⚠️最優先: Containers からの生 TCP アウトバウンド（Postgres 5432 / Redis 6379）** — 公式ドキュメント間で矛盾。**PoC-1 で潰す**
2. **`@n8n/tournament` の同期 API を Worker Loader で非同期化する改造の実現可能性と規模** — **PoC-2 で潰す**
3. **R2 バイナリデータ外部化の Enterprise ライセンス要否**（`.ee` サフィックス由来の疑い）
4. **Containers の対応 CPU アーキテクチャ**（amd64 のみか arm64 も可か）— 公式に明示なし
5. **Containers のリクエストタイムアウト / 最大リクエスト時間** — 公式に明示なし
6. **Hyperdrive を Containers から使えるか** — ドキュメントは Workers 統合のみを扱う
7. **`process.version` が Workers 上で返す具体値** — 一次・第三者いずれにも記載なし。起動時 semver ガードを持つライブラリの可否に影響
8. **`enable_nodejs_fs_module` の既定 compat date** — capnp 2025-09-15 vs docs 2025-09-01
9. **n8n 2.x のマイグレーションが外部 PostgreSQL に対して初回起動時に正しく走るか**
10. **Containers のコールドスタート実測値**（`sleepAfter` からの復帰時間）— Webhook の応答性に直結
11. **D1 read replication の GA 化状況** — 2026-07 時点で GA アナウンス未確認
12. **「ネイティブアドオン非対応」の明文ステートメント** — workerd Discussion #1905 での Cloudflare の表明（*"Node.js native add-ons are likely never to be supported by workers"*）のみで、ドキュメント本体に記載なし
13. **Workflows → Containers の呼び出し** — 構造上は可能だが明示したドキュメントページが存在しない

---

## 10. 次のアクション

**Phase 0 の 1〜4 を実施します。** 具体的には Workers Paid を有効化し、`wrangler.jsonc` でプロジェクトを初期化した上で、**PoC-1（Container → 外部 Postgres の生 TCP）と PoC-2（Worker Loader 版 FunctionEvaluator）を並行で走らせます。**

この 2 つの結果が出るまで、経路 A のイメージ構築にも経路 B の本実装にも着手しません。

---

## 付録: 出典

**Cloudflare 公式**
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) /
[compatibility-flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) /
[Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) ·
[fs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) ·
[timers](https://developers.cloudflare.com/workers/runtime-apis/nodejs/timers/) /
[tcp-sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) /
[static-assets](https://developers.cloudflare.com/workers/static-assets/binding/) /
[bundling](https://developers.cloudflare.com/workers/wrangler/bundling/) /
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ·
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) /
[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) ·
[DO websockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) /
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) /
[Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) /
[Workflows](https://developers.cloudflare.com/workflows/) ·
[limits](https://developers.cloudflare.com/workflows/reference/limits/) ·
[pricing](https://developers.cloudflare.com/workflows/reference/pricing/) /
[Containers](https://developers.cloudflare.com/containers/) ·
[limits](https://developers.cloudflare.com/containers/platform-details/limits/) ·
[pricing](https://developers.cloudflare.com/containers/pricing/) ·
[architecture](https://developers.cloudflare.com/containers/platform-details/architecture/) ·
[container-class](https://developers.cloudflare.com/containers/container-class/) ·
[outbound-traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/) ·
[faq](https://developers.cloudflare.com/containers/faq/) ·
[r2-fuse-mount](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/) /
[Dynamic Workers](https://developers.cloudflare.com/dynamic-workers)

**一次ソース**
[workerd compatibility-date.capnp](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/io/compatibility-date.capnp) /
[workerd #1905（native addon 非対応の表明）](https://github.com/cloudflare/workerd/discussions/1905)

**Cloudflare Changelog / Blog**
[startup 400ms→1s (2025-10-10)](https://developers.cloudflare.com/changelog/2025-10-10-increased-startup-time/) /
[subrequests 緩和 (2026-02-11)](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) /
[KV-backed DO 新規制限 (2026-07-09)](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/) /
[Node.js HTTP servers (2025-09-08)](https://blog.cloudflare.com/bringing-node-js-http-servers-to-cloudflare-workers/) /
[Containers + Sandboxes GA (2026-04-13)](https://blog.cloudflare.com/sandbox-ga/) /
[Workflows GA (2025-04-07)](https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/) /
[MoltWorker (InfoQ, 2026-02)](https://www.infoq.com/news/2026/02/cloudflare-moltworker/)

**n8n**
[root package.json](https://raw.githubusercontent.com/n8n-io/n8n/master/package.json) ·
[n8n-workflow](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/workflow/package.json) ·
[n8n-core](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/core/package.json) ·
[n8n-cli](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/cli/package.json) /
[LICENSE.md](https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md) /
[choose-n8ns-database](https://docs.n8n.io/deploy/host-n8n/configure-n8n/choose-n8ns-database) /
[task-runners](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-task-runners) ·
[task-runner-launcher](https://github.com/n8n-io/task-runner-launcher) /
[binary-data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/binary-data/) /
[OEM deployment](https://docs.n8n.io/deploy/host-n8n/deploy-as-an-oem-integration)

**先行事例・代替**
[Dafthunk](https://github.com/dafthunk-com/dafthunk) ·
[Dafthunk vs n8n](https://www.dafthunk.com/alternatives/n8n) /
[Stackbilt-dev/n8n-transpiler](https://github.com/Stackbilt-dev/n8n-transpiler) /
[pigri/cf-n8n-proxy](https://github.com/pigri/cf-n8n-proxy) /
[Strapi 公式拒否](https://feedback.strapi.io/developer-experience/p/support-for-cloudflare-worker) /
[socket.io #5019](https://github.com/socketio/socket.io/discussions/5019) /
[Why doesn't n8n like serverless containers?](https://community.n8n.io/t/why-doesnt-n8n-like-serverless-containers/282850)

**本リポジトリ内**
[`experiments/workerd-n8n-workflow/`](./experiments/workerd-n8n-workflow/) — §4 の実測の再現用ファイル一式
