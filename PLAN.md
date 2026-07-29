# cf-n8n — n8n を Cloudflare 開発者プラットフォームで動かす計画

調査日: 2026-07-29 / 調査対象: n8n `2.33.0`（master）、Cloudflare Workers・Containers 公式ドキュメント

---

## 1. 結論（先に要点）

**Workers（workerd アイソレート）上で n8n 本体をそのまま動かすことは、2026 年 7 月時点で不可能です。** 障害は互換性の細かい穴ではなく、バンドルサイズ・メモリ・ネイティブアドオンという桁違いの構造的制約にあります。

一方で **Cloudflare Containers が Workers Paid プランで GA になっており、n8n は「ほぼそのまま」動かせます。** ただし n8n のデフォルト構成（SQLite をローカルディスクに置く）はコンテナのディスクが揮発性であるため成立せず、永続層の外部化が必須です。

したがって本プロジェクトは次の二段構えとします。

- **トラック A（実用）**: Containers 上で n8n 本体を動かし、永続層を外部化する。数日〜2 週間で実運用ラインに到達可能。
- **トラック B（挑戦）**: `n8n-workflow` をコアに据えた **Workers ネイティブの n8n 互換ワークフロー実行ランタイム** を自作する。n8n のワークフロー JSON を入力として受け取り、対応ノードのサブセットを Worker 上で実行する。

トラック A を先に立ち上げて「動く n8n」を確保し、その実行結果をトラック B の互換性検証リファレンスとして使うのが最も効率的です。

---

## 2. 調査結果 — n8n 側

### 2.1 バージョンと構成

| 項目 | 値 |
|---|---|
| バージョン | `2.33.0` |
| Node.js 要件 | `>=22.22` |
| パッケージマネージャ | `pnpm@10.32.1`（`>=10.22.0`） |
| ビルド | Turbo 2.9.15 + TypeScript 6.0.2 + esbuild |
| monorepo 構成 | `packages/` 配下に `@n8n`, `cli`, `core`, `extensions`, `frontend`, `node-dev`, `nodes-base`, `testing`, `workflow` |

### 2.2 各パッケージの「移植しやすさ」

移植可能性を左右するのは依存の純度です。実際の `package.json` を確認した結果は以下のとおりです。

**`n8n-workflow`（2.33.0）— 最も純度が高く、移植の足がかりになる**

依存は `@n8n/tournament`（式評価エンジン）、`@n8n/expression-runtime`、`esprima-next`・`recast`・`ast-types`（式パース用 AST 処理）、`axios`、`lodash`、`luxon`、`jmespath`、`xml2js`、`js-base64`、`jssha`、`md5`、`uuid`、`transliteration`、`jsonrepair`、`@sentry/core`、`@sentry/node`、`ssh2` の 25 件。peerDependency に `zod`。

CJS/ESM 両方の dist を持ち、`n8n-workflow`、common、expression sandbox の 3 エントリポイントを export しています。**ワークフロー定義・ノードインタフェース・式評価という「エンジンの頭脳」部分がここに集約されており、DB にもサーバにも依存していません。** ただし `ssh2` と `@sentry/node` は Node 依存が強いため、バンドル時に alias 差し替えまたは tree-shake が必要です。

**`n8n-core`（2.33.0）— 実行時ヘルパー。ネイティブ依存が混入する**

依存 36 件のうち移植の障害になるのは **`@sentry/node-native` と `@sentry/profiling-node`（いずれもネイティブアドオン）**、`ssh2`、`cron`、`fast-glob`、`file-type`、`chardet`、`winston` など。加えて `@n8n/blob-storage`、`@n8n/backend-network`、`@n8n/di`（DI コンテナ）、`@langchain/core` に依存しており、バックエンド前提の作りです。

**`n8n-cli` — サーバ本体。Workers 移植は不可能**

確認できた本番依存に以下が含まれます。

- `express`（HTTP サーバ）
- `@n8n/typeorm`（n8n 独自の TypeORM フォーク）
- **`sqlite3@5.1.7`（ネイティブアドオン、node-gyp ビルド必須）**
- `pg`（PostgreSQL ドライバ）
- `bcryptjs@2.4.3`（純 JS なのでこれ自体は問題なし）
- `bull@4.16.4` + `ioredis@5.3.2`（queue モード用。Redis 必須）
- `ws@8.20.1`（push 通信）

公式 Dockerfile はマルチステージ構成で、**builder ステージでネイティブアドオンをコンパイルしてから Alpine 3.24 ベースの最終レイヤに移す**作りになっています。これはネイティブビルドが必須であることの裏付けです。カスタムイメージは 1GB を超えるのが通例で、サイズの大半は `node_modules`（特に `nodes-base`）が占めます。

### 2.3 Task Runners（Code ノードの実行基盤）

n8n は Code ノードのユーザーコードを**別プロセス**で実行します。モードは 2 つ。

- **internal モード**: n8n 本体が `child_process` で Task Runner を起動し、ライフサイクルを管理する。公式は本番非推奨。
- **external モード**: Go 製の `task-runner-launcher` が Task Broker と連携し、必要時にランナープロセスを起動する。実運用では `n8nio/runners` イメージをサイドカーコンテナとして並走させる。

**どちらのモードもプロセス分離を前提としており、後述するとおり Workers では `child_process` も `worker_threads` もスタブ実装しかないため、Code ノードは Workers ネイティブでは動作しません。**

### 2.4 ライセンス — Sustainable Use License v1.0

これは設計判断より先に効いてくる制約なので明記します。

- 許可される用途は **「internal business purposes」または「non-commercial or personal use」** に限定される。
- 再配布は **非商用目的かつ無償の場合のみ**。商用ホスティング・SaaS 提供・第三者の便益のための提供は禁止。
- **改変した場合、改変した旨の明示的な注記（prominent notice）を改変版に含める義務がある。**
- パス中に `.ee.` または `.ee` を含むファイルは Enterprise License が別途必要。
- 違反時はライセンス自動終了。初回は通知から 30 日以内に是正すれば遡って回復するが、再違反は恒久終了。

→ **本プロジェクトが個人利用・自己ホストの範囲に留まる限り問題ありません。** ただし「Cloudflare 上で動く n8n」を他者に提供する形にすると抵触します。またトラック A・B いずれも改変を伴うため、**改変注記の記載を成果物に含める必要があります。**

---

## 3. 調査結果 — Cloudflare 側

### 3.1 Workers ランタイムの制限

| 項目 | Free | Paid |
|---|---|---|
| スクリプトサイズ（gzip 後） | 3 MB | **10 MB** |
| スクリプトサイズ（非圧縮） | 64 MB | 64 MB |
| アイソレートあたりメモリ | **128 MB** | **128 MB** |
| リクエストあたり CPU 時間 | 10 ms | 30 秒（既定）／最大 5 分まで設定可 |
| 起動時間（グローバルスコープ実行） | **1 秒** | **1 秒** |
| サブリクエスト数 | 50 | 10,000（最大 1000 万まで拡張可） |
| 同時アウトバウンド接続 | 6 | 6 |
| Cron Triggers（アカウント毎） | 5 | 250 |
| Worker 数（アカウント毎） | 100 | 500 |

HTTP リクエストのウォールクロックにはクライアント接続が続く限り上限なし。ただし **Cron Trigger・Queue コンシューマ・Durable Object アラームは 15 分** が上限です。

### 3.2 Node.js 互換性（`nodejs_compat`）

2026 年に入って大きく改善しています。互換性日付 `2024-09-23` 以降 + `nodejs_compat` フラグが前提。

**🟢 サポート済み**: `fs`, `net`, `http`, `https`, `path`, `crypto`, `stream`, `buffer`, `events`, `process`, `zlib`

**🟡 部分サポート**: `os`, `tls`, `module`

**🔴 スタブのみ（実質使用不可）**:
- `child_process`（2026-03-17 有効化、スタブ）
- `worker_threads`（2026-03-17 有効化、スタブ）
- `vm`（2025-10-01、スタブ）
- `cluster`（2025-12-04、スタブ）
- `dgram`（2026-01-29、スタブ）

**ネイティブアドオン（`.node`）についてはドキュメントに記載がなく、workerd の設計上サポートされません。**

#### `node:fs` の実体に注意

`fs` が 🟢 になったのは朗報ですが、**実体は仮想メモリファイルシステム（VFS）** です。

- `/bundle` — Worker バンドル同梱モジュールの**読み取り専用**アクセス
- `/tmp` — 書き込み可能。ただし **リクエストごとに独立し、永続しない**（同時実行中の他リクエストからも見えない）
- `/dev` — `null`, `random`, `full`, `zero`
- 単一ファイル最大 128 MB だが、**一時ファイルは Worker のメモリ上限（128MB）に算入される**
- 非対応: `fs.watch` / `fs.watchFile`、`fs.globSync()`、`fs.rm` の `force` オプション、パーミッション・所有権、タイムスタンプ（常に Unix エポック）
- 互換性日付 `2025-09-01` 以降は既定で利用可。それ以前は `enable_nodejs_fs_module` フラグを併用

→ **n8n が期待する「永続的な書き込み可能ディスク」（SQLite ファイル、バイナリデータ、`~/.n8n`）としては一切使えません。**

### 3.3 Durable Objects

| 項目 | 値 |
|---|---|
| SQLite ストレージ / DO | 10 GB |
| SQLite / アカウント | Paid 無制限、Free 5 GB |
| CPU / リクエスト | 30 秒（既定）／最大 5 分 |
| リクエスト/秒（ソフト上限） | オブジェクトあたり 1,000 |
| キー + 値の合計 | 2 MB 以内 |
| WebSocket 受信メッセージ | 32 MiB |
| SQL 文の最大長 | 100 KB |
| テーブルあたり最大カラム数 | 100 |
| バインドパラメータ数 | 100 |
| クラス数 / アカウント | Paid 500、Free 100 |
| オブジェクト実体数 | 無制限 |

SQLite バックエンドの DO は Free・Paid 双方で利用可能。**「1 ワークフロー実行 = 1 Durable Object」というモデルはこの制限によく適合します。**

### 3.4 Cloudflare Containers（GA、Workers Paid プラン）

Containers は **Durable Object として実装されており**、Worker のコードから制御します。Dockerfile を `wrangler.jsonc` で指定して `wrangler deploy` するだけです。

**インスタンスタイプ**

| タイプ | vCPU | メモリ | ディスク |
|---|---|---|---|
| lite（旧 `dev`） | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1（旧 `standard`） | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

カスタム指定は vCPU 1〜4、メモリ最大 12 GiB、ディスク最大 20 GB。**「vCPU あたり最低 3 GiB メモリ」「メモリ 1 GiB あたりディスク最大 2 GB」** の比率制約あり。

**アカウント上限**: 同時メモリ 6 TiB、同時 vCPU 1,500、同時ディスク 30 TB、イメージサイズは対応インスタンスのディスク上限（最大 20 GB）まで、**アカウント合計のイメージストレージ 50 GB**。

**料金（Workers Paid に含まれる無料枠つき）**

| 資源 | 無料枠 | 超過分 |
|---|---|---|
| メモリ | 25 GiB-時/月 | $0.0000025 / GiB-秒 |
| CPU | 375 vCPU-分/月 | $0.000020 / vCPU-秒 |
| ディスク | 200 GB-時/月 | $0.00000007 / GB-秒 |
| 下り（北米・欧州） | 1 TB/月 | $0.025 / GB |

課金はリクエスト到達時または手動起動時に始まります。**メモリとディスクはプロビジョニング量に対して課金され、CPU は実稼働分のみ。**

**コード形状**

```jsonc
// wrangler.jsonc
{
  "containers": [
    { "max_instances": 10, "class_name": "MyContainer", "image": "./Dockerfile" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "MY_CONTAINER", "class_name": "MyContainer" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyContainer"] }]
}
```

```ts
export class MyContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10s';           // アイドル時の自動停止
  envVars = { /* ... */ };
  override onStart() {}
  override onStop() {}
  override onError(error: unknown) {}
}

// ルーティング: 名前で固定インスタンスに割り当て
const container = env.MY_CONTAINER.getByName(pathname);
return await container.fetch(request);

// あるいはロードバランス
const container = await getRandom(env.MY_CONTAINER, 3);
return await container.fetch(request);
```

### 3.5 参考になる先行事例

- **Cloudflare MoltWorker**（2026-02）— 自己ホスト型 AI エージェント Moltbot を Cloudflare 上で動かす公式オープンソース実装。**Worker を API ルータ兼管理層とし、実体は Sandbox コンテナで動かす**構成で、状態は R2 に永続化、認証は Zero Trust Access。まさに本プロジェクトが採るべきアーキテクチャの雛形です。ただし Cloudflare 自身が「プロダクトではなく PoC」と位置づけている点は留意。
- **Dafthunk** — MIT ライセンスの Workers ネイティブなワークフロー自動化基盤。状態を D1 と R2 に置き、アイドル時ゼロスケール、Workers AI を推論に使用。**トラック B が目指す形の実在する証明**であり、設計上の参照先として非常に有用です。

---

## 4. 制約の突き合わせ — なぜ Workers ネイティブが不可能か

| n8n の要求 | Workers の現実 | 判定 |
|---|---|---|
| `sqlite3@5.1.7`（ネイティブアドオン） | `.node` 非サポート | ❌ 致命的 |
| `@sentry/node-native`, `@sentry/profiling-node` | 同上 | ❌ 致命的 |
| `node_modules` 1GB 超 | gzip 10 MB / 非圧縮 64 MB | ❌ 桁が 2 つ違う |
| プロセス常駐・大量ノード定義のロード | 起動 1 秒、メモリ 128 MB | ❌ |
| Task Runner のプロセス分離 | `child_process`・`worker_threads` はスタブのみ | ❌ Code ノード不可 |
| 永続ディスク（`~/.n8n`、バイナリデータ） | `/tmp` はリクエスト単位で揮発 | ❌ |
| Express HTTP サーバ | `node:http` は 🟢 | ⚠️ 理論上は可だが上記が先に詰む |
| Redis（bull / ioredis） | `net` 🟢 なので TCP は可 | ⚠️ 外部 Redis があれば可 |
| PostgreSQL（`pg`） | `net` 🟢 + Hyperdrive | ⚠️ 可 |

**結論: 単体の障害なら回避策を積めますが、バンドルサイズとネイティブアドオンは回避不能です。**

一方 Containers 側では、唯一の設計上の落とし穴は **コンテナのディスクが揮発性である**ことです。n8n 既定の SQLite（`~/.n8n/database.sqlite`）に依存したまま運用すると、インスタンス再起動・`sleepAfter` による停止のたびにワークフローと認証情報が消えます。**永続層の外部化が必須要件です。**

---

## 5. 方針の選択肢

### 案 A: Containers に n8n 本体を載せる（実用重視）

Worker をフロント（ルーティング・認証・カスタムドメイン終端）に置き、コンテナで n8n フルスタックを動かす。

- **永続層**: PostgreSQL を外部に置く（Neon / Supabase など）。コンテナ内から `pg` で直結、または Worker 経由で Hyperdrive を使う。
- **バイナリデータ**: n8n の S3 互換バイナリデータストアを **R2** に向ける。
- **インスタンス**: `standard-2`（1 vCPU / 6 GiB / 12 GB）から開始。n8n の推奨最小構成に近い。
- **アイドル制御**: `sleepAfter` を設定。ただし後述のとおりトリガー系との相性に注意。

**利点**: n8n の全機能（1000 種超のノード、Code ノード、AI エージェント機能）がそのまま動く。改修量が最小。アップストリーム追従が容易。

**欠点**: 「Cloudflare Workers で動かす」という当初の目標に対しては、実質「Cloudflare 上のコンテナホスティング」であり、エッジ実行の利点（ゼロスケール・グローバル分散・低レイテンシ）はほぼ得られない。24 時間常駐させると月額はおおむね VPS 並み（メモリ 6 GiB 常時で概算 $40/月前後 + Workers Paid $5、CPU は実稼働分のみ）。

**`sleepAfter` の落とし穴**: スケジュールトリガー（cron）を持つワークフローがある場合、コンテナが寝ていると発火しません。**Worker 側の Cron Trigger（Paid で 250 個）でコンテナを起こす**設計にするか、常時起動を受け入れるかの判断が要ります。前者を推奨します。

### 案 B: Workers ネイティブの n8n 互換ランタイムを自作（挑戦重視）

`n8n-workflow` をエンジンとして取り込み、n8n のワークフロー JSON を実行できる独自ランタイムを Worker 上に構築する。

- **エンジン**: `n8n-workflow` の `Workflow` クラスと式評価（`@n8n/tournament`）を流用。`ssh2` / `@sentry/node` は alias で空実装に差し替え。
- **ノード**: `nodes-base` 全体は諦め、**HTTP Request、Webhook、Schedule、Code（後述）、Set、IF、Switch、Merge、Code-free な変換系** などのサブセットを Workers 向けに再実装する。
- **永続層**: ワークフロー定義・実行履歴は **D1**。バイナリデータは **R2**。
- **実行状態**: 1 実行 = 1 **Durable Object**（SQLite バックエンド、10 GB / CPU 最大 5 分）。長時間・多ステップの実行は **Cloudflare Workflows**（durable execution）に載せることで、リトライと sleep を基盤側に委ねられる。
- **Code ノード**: `vm` がスタブのため、`@n8n/tournament` の式サンドボックスの範囲に留めるか、Containers 側にコード実行だけを逃がす。
- **エディタ UI**: n8n の `frontend` は API 前提のため、そのまま流用するのは困難。当面は「n8n 本家で作った JSON をインポートする」方式とし、UI 自作は後回しにする。

**利点**: 真のゼロスケール、グローバル分散、実行あたりのコストが桁違いに安い。Dafthunk が同種の設計で成立していることが実現可能性の証拠。

**欠点**: 実装量が大きい。ノード互換性は永久に不完全。Code ノードの扱いが構造的に苦しい。

### 案 C: ハイブリッド（案 A + 案 B）

Worker をルータとし、**実行するワークフローの内容に応じて振り分ける**。対応ノードのみで構成されたワークフローは Worker ネイティブで実行し、非対応ノードを含むものはコンテナの n8n に委譲する。コンテナは `sleepAfter` で普段は寝かせておく。

---

## 6. 推奨方針

**案 A を Phase 1 で完成させ、その上に案 B を Phase 2 以降で積み、最終的に案 C の形に収束させる。**

理由は 3 点です。第一に、案 A は数日で「動く n8n」に到達でき、以降の互換性検証の正解データを提供します。第二に、案 B は単独では成果が出るまでの期間が長く、途中で頓挫したときに何も残りません。第三に、案 C の振り分けロジックは案 A と案 B の両方が存在して初めて意味を持ちます。

---

## 7. ロードマップ

### Phase 0 — 足場づくり

- Workers Paid プランの有効化（Containers は Paid 必須）
- `wrangler` プロジェクト初期化、`compatibility_date` を 2025-09-01 以降に設定、`nodejs_compat` フラグ有効化
- 外部 PostgreSQL の用意（Neon 無料枠から開始）
- R2 バケット作成（バイナリデータ・エクスポート用）
- **ライセンス遵守**: 改変を加える以上、リポジトリに Sustainable Use License の写しと「改変した旨の注記」を配置する

### Phase 1 — Containers 上で n8n を動かす（案 A）

1. `n8nio/n8n` 公式イメージをベースにした Dockerfile を作成。ネイティブアドオンのビルド済みイメージをそのまま使うため、自前ビルドは避ける
2. `wrangler.jsonc` に `containers` / `durable_objects` / `migrations` を定義。`instance_type` は `standard-2` から
3. `Container` サブクラスを実装（`defaultPort = 5678`、`sleepAfter`、`envVars` で n8n の設定を注入）
4. 環境変数で永続層を外部化
   - `DB_TYPE=postgresdb` および接続情報 → 外部 PostgreSQL
   - バイナリデータを S3 互換モードにして R2 のエンドポイントを指す
   - `N8N_ENCRYPTION_KEY` を Wrangler Secret で固定（**これが変わると保存済み認証情報が全て復号不能になります**）
5. Worker 側でルーティング。`getByName` で単一インスタンスに固定（n8n はステートフルなのでロードバランスしてはいけない）
6. Webhook の到達性確認、Cloudflare Access による管理 UI の保護
7. **cron ワークフロー対策**: Worker の Cron Trigger を設置し、定期的にコンテナを起こす
8. コスト実測（1 週間運用してメモリ・CPU・ディスクの実消費を計測し、インスタンスタイプを見直す）

**Phase 1 の完了条件**: ブラウザから n8n エディタが開け、ワークフローを保存でき、コンテナを再起動しても消えず、Webhook とスケジュール実行の両方が発火する。

### Phase 2 — Workers ネイティブ実行エンジンの PoC（案 B の第一歩）

1. `n8n-workflow` を Worker にバンドルできるか検証する。**これが Phase 2 全体の可否を決めるゲートです。** `ssh2` / `@sentry/node` / `@sentry/core` を空実装に alias し、esbuild でバンドルして 10 MB gzip に収まるか、起動 1 秒に収まるかを測る
2. 収まる場合: `Workflow` クラスで最小ワークフロー（Manual Trigger → Set → HTTP Request）を実行させる PoC を書く
3. 収まらない場合: `n8n-workflow` 全体の取り込みを諦め、式評価（`@n8n/tournament`）とワークフロー JSON の型定義のみを借りて、実行グラフの走査は自前で書く方向に切り替える
4. D1 にワークフロー定義を保存し、n8n 本家のエクスポート JSON をインポートできるようにする

### Phase 3 — ノードサブセットとステート管理

1. Durable Object（SQLite バックエンド）に「1 実行 = 1 DO」で実行状態を保持
2. 長時間・多ステップ実行は Cloudflare Workflows に載せ、リトライと sleep を基盤に委譲
3. ノード実装の優先順位: Webhook / Schedule / HTTP Request / Set / IF / Switch / Merge / Split In Batches
4. バイナリデータは R2、`node:fs` の VFS は**中間バッファとしてのみ**使う（永続化に使わない）

### Phase 4 — 振り分け（案 C）

1. ワークフロー JSON を静的解析し、含まれるノード型が Worker ネイティブ実装のカバー範囲に収まるか判定する
2. 収まる → Worker で実行。収まらない → コンテナの n8n に委譲
3. コンテナの `sleepAfter` を短く設定し、アイドルコストを削る

---

## 8. リスクと未確認事項

**確認済みの前提が崩れうる点**

- Cloudflare Containers のディスクがインスタンス停止をまたいで永続するかは公式ドキュメントで明示されていません。**揮発する前提で設計しますが、Phase 1 で実測して確認すべきです。** 仮に永続したとしても、SQLite をコンテナディスクに置く設計は再現性の観点から推奨しません。
- Workers のネイティブアドオン非サポートは公式ドキュメントに明記がなく、workerd のアーキテクチャからの推論です。ただし結論は変わりません。
- n8n の S3 互換バイナリデータストアが R2 で問題なく動くかは未検証です。R2 の S3 API 互換性は高いものの、マルチパートアップロードや署名バージョンの差異でつまずく可能性があります。

**設計上のリスク**

- `N8N_ENCRYPTION_KEY` の管理ミスは認証情報の全損に直結します。Phase 0 で Wrangler Secret に固定し、別途バックアップを取ってください。
- Durable Object の「オブジェクトあたり 1,000 req/s ソフト上限」は、単一コンテナに全トラフィックを集約する Phase 1 の構成では上限になりえます。個人利用の規模では問題になりません。
- 同時アウトバウンド接続 6 という制約は、多数の HTTP Request ノードを並列実行するワークフローで効いてきます。Phase 3 の実装で並列度を絞る必要があります。
- ライセンス上、この成果物を第三者にホスティングサービスとして提供することはできません。個人利用・自己ホストの範囲に留めてください。

**未調査で、着手前に確認すべきこと**

- n8n 2.x のマイグレーションが外部 PostgreSQL に対して初回起動時に正しく走るか
- Cloudflare Containers のコールドスタート実測値（`sleepAfter` からの復帰時間）。Webhook の応答性に直結します
- `n8n-workflow` の実バンドルサイズ（Phase 2 の 1 番で測る）

---

## 9. 次のアクション

Phase 0 と Phase 1 の 1〜4 を進めます。具体的には、Dockerfile と `wrangler.jsonc` を書き、外部 PostgreSQL と R2 を繋いだ状態で最初のデプロイを通すところまでです。

---

## 出典

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Node.js compatibility in Workers](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [node:fs in Workers](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/)
- [Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Containers get started](https://developers.cloudflare.com/containers/get-started/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [n8n root package.json](https://raw.githubusercontent.com/n8n-io/n8n/master/package.json) / [n8n-workflow](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/workflow/package.json) / [n8n-core](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/core/package.json) / [n8n-cli](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/cli/package.json)
- [n8n LICENSE.md（Sustainable Use License v1.0）](https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md)
- [n8n Task runners docs](https://docs.n8n.io/hosting/configuration/task-runners/) / [task-runner-launcher](https://deepwiki.com/n8n-io/task-runner-launcher)
- [n8n Docker deployment](https://deepwiki.com/n8n-io/n8n/7.3-docker-deployment)
- [Cloudflare MoltWorker（InfoQ, 2026-02）](https://www.infoq.com/news/2026/02/cloudflare-moltworker/)
- [Dafthunk — Workers ネイティブのワークフロー基盤](https://www.dafthunk.com/alternatives/n8n)
