# 実験: Neon への接続経路の検証

実施日 2026-07-29 / `@neondatabase/serverless@1.1.0` / Node v25.8.0 / `wrangler 4.115.0`

**結論: n8n の DB を Neon にすると、Cloudflare Containers の「生 TCP アウトバウンドが可能か不明」という未検証リスクを完全に回避できる。** Neon は 443 だけで完結するためです。

## 手順

```bash
npm install
node node-probe.cjs                  # Node（= Container 内相当）からの到達性
npx wrangler dev                     # workerd 上でのロード検証（entry-neon.js）
```

## 検証 1 — Node から Neon へ到達できるか

`node-probe.cjs` は **存在しないエンドポイント名 + でたらめな認証情報**で接続を試み、返るエラーの種類で到達性を判定します。DNS エラーでも接続拒否でもなく **Postgres の認証エラー**が返れば、443 で Neon の実インフラまで届いている証拠になります。

```
Node: v25.8.0 | global WebSocket: function
neonConfig.webSocketConstructor (未設定時): undefined
(A) 素の Pool        → DatabaseError | password authentication failed for user 'u'
(B) WebSocket 注入   → DatabaseError | password authentication failed for user 'u'
(C) HTTP(neon タグ)  → NeonDbError   | password authentication failed for user 'u'
```

**3 経路すべてで Postgres レベルの認証エラーが返りました。** つまりネットワークは通っています。

さらに重要なのが **(A) と (B) の結果が同じ**である点です。`neonConfig.webSocketConstructor` は未設定（`undefined`）のままでも WebSocket モードが動作しました。**Node 22+ のグローバル `WebSocket` を driver が自動的に拾うため、コンテナ内で shim を書く必要はありません。**

裏付け:

```
$ getent hosts ep-nonexistent-test.ap-southeast-1.aws.neon.tech
2406:da18:94d:8228:... ap-southeast-1.aws.neon.tech    # ワイルドカード DNS
$ curl -o /dev/null -w "HTTP %{http_code} / port=%{remote_port} / ip=%{remote_ip}" \
    https://ep-nonexistent-test.ap-southeast-1.aws.neon.tech/sql
HTTP 400 / port=443 / ip=52.220.170.93                  # Neon 実インフラ
```

`*.<region>.aws.neon.tech` はワイルドカード DNS で解決し、SNI でエンドポイントを識別する構成です。だから存在しない名前でも proxy まで届き、そこで認証に失敗します。

**`ap-southeast-1`（シンガポール）リージョンが存在する**ことも確認できました。Cloudflare Containers の `APAC` と組み合わせられます。

## 検証 2 — workerd 上で driver がロードできるか

`entry-neon.js` を `wrangler dev` で実行:

```json
{
 "exports": { "Pool": "function", "Client": "function", "neon": "function", "neonConfig": "function" },
 "globalWebSocket": "function",
 "poolConstructed": true,
 "poolQueryType": "function",
 "neonTaggedType": "function",
 "cfConnect": "function"
}
```

`compatibility_date: 2025-09-15` + `nodejs_compat` で、**Pool の構築まで成功**。`cloudflare:sockets` の `connect` も利用可能でした（Workers ネイティブ経路を採る場合の選択肢）。

## 検証 3 — n8n の TypeORM が pg の差し替えを受け入れるか

`@n8n/typeorm@0.6.0` の `dist/driver/postgres/PostgresDriver.js:1108`:

```js
loadDependencies() {
    try {
        const postgres = this.options.driver || require('pg');
        this.postgres = postgres;
    }
    catch (e) {
        throw new DriverPackageNotInstalledError('Postgres', 'pg');
    }
}
```

**`this.options.driver || require('pg')`** という単純な解決です。したがって Neon 公式が案内する npm エイリアス方式がそのまま効きます。

```json
{
  "dependencies": { "pg": "npm:@neondatabase/serverless@^1.0.0" },
  "overrides":    { "pg": "npm:@neondatabase/serverless@^1.0.0" }
}
```

Dockerfile 内でこの override を適用すれば、n8n 本体に手を入れずに接続経路を 443 へ寄せられます。

## 未検証（実 DB とデプロイが要る）

- 実際の Neon インスタンスに対する n8n の**初回マイグレーション**の成否
- **PgBouncer pooled endpoint（`-pooler`）と TypeORM の prepared statement の相性**
- Cloudflare Containers から実際に 443 で Neon に出られるか（本実験は通常の Linux ホストからの確認であり、Containers 上ではない）
- 生 TCP 5432 が Containers から出られるか（本実験のホストからは `5432 OPEN` だが、Containers の挙動を示すものではない）

---

## 付録: Neon の運用特性（採用見送り後の参考資料）

本プロジェクトは **Track B（Workers ネイティブ + D1）** を採ったため Neon は使いませんが、将来 Postgres が必要になった場合に備えて調査結果を残します。以下は Neon 公式ドキュメントと **Neon / n8n 双方のソースコード**で確認した事実です。

### scale to zero のアイドル判定 — ソースレベルで確定

Neon の compute 監視デーモン `compute_tools/src/monitor.rs` は 500ms 間隔で `pg_stat_activity` を見ています。

```rust
const MONITOR_CHECK_INTERVAL: Duration = Duration::from_millis(500);
```

```rust
if state == "idle" {
    idle_backs.push(t);              // state_change を集めるだけ
} else {
    return Ok(Some(Utc::now()));     // 非 idle なら即「今アクティブ」
}
```

| 状況 | 判定 |
|---|---|
| 接続が開いているだけ（`state='idle'`） | **アクティブ扱いにならない**。その接続の `state_change` が基準になるだけ |
| `state='active'` | 即座に「今アクティブ」 |
| `state='idle in transaction'` | 文字列 `'idle'` と不一致 → **即座にアクティブ扱い** |

**したがって「アイドル接続の張りっぱなし」ではサスペンドを防げませんが、n8n の `DB_PING_INTERVAL_SECONDS=2`（既定）は 2 秒ごとに `state_change` を更新するため、5 分のしきい値に永久に到達しません。** 本文で述べた「Free は 17 日目に停止する」という見立ては、この実装で裏付けられます。

`DB_PING_INTERVAL_SECONDS` を伸ばして Neon を寝かせる案は**逆効果**です。n8n プロセスが生きている間はいつクエリが来てもおかしくないため、CU-hours はほぼ節約できず、コールドスタート（実測 300〜500ms）を招くだけになります。

### ★ pooled endpoint（`-pooler`）は使ってはいけない

`@n8n/typeorm` の `PostgresDriver` は接続取得のたびに **`SET LOCAL` ではない素の `SET`** を発行します。

```typescript
await connection.query('SET search_path TO public');
await connection.query(`SET statement_timeout = ${statementTimeout}`);
```

Neon が transaction pooling で「使えない」と公式に列挙している機能の筆頭が、まさに **`SET` によるセッション変数**です。pooled 越しではこの `SET` がたまたま割り当てられたサーバ接続に適用されて返却されるため、`DB_POSTGRESDB_STATEMENT_TIMEOUT` が効いたり効かなかったりし、`DB_POSTGRESDB_SCHEMA` を public 以外にすると `search_path` が効かずテーブルが見つからない事故が起こりえます。**エラーにならず静かに壊れる**類の問題です。

n8n の `DB_POSTGRESDB_POOL_SIZE` は既定 **2** で、direct 接続でも 0.25〜2 CU で **839 接続**使えますから、**pooling を使う動機がそもそもありません。direct（`-pooler` なし）一択**です。

なお prepared statement については心配無用でした。Neon の pooler は **PgBouncer 1.22.0+ の protocol-level prepared statement 対応済み**（`max_prepared_statements=1000`）で、かつ `pg` は既定で named prepared statement を作りません。advisory lock も n8n は **transaction-scoped**（`pg_advisory_xact_lock`）を使っており pooling 互換です。

### 接続数はプランではなく compute サイズで決まる

```
compute_size    = min(max_compute_size, 8 × min_compute_size)
max_connections = max(100, min(4000, floor(compute_size × 419.66)))
```

min が 0.25 のままだと `8 × 0.25 = 2` で頭打ちになるため、**max を 16 CU に上げても `max_connections` は 839 のまま**です。

### リージョン — 東京はありません

AWS は `us-east-1` / `us-east-2` / `us-west-2` / `eu-central-1` / `eu-west-2` / **`ap-southeast-1`（Singapore）** / `ap-southeast-2`（Sydney）/ `sa-east-1`。**`ap-northeast-1`（東京）は 2026-07 時点で未提供**で、リクエストは 2024 年から立ったままです。アジアでは **Singapore が唯一の現実的選択肢**になります。

### Free プランの罠

CU-hours（100）または public network transfer（5 GB）を超過すると **compute が翌請求期間まで suspend** されます。ストレージ 0.5 GB を超えると **INSERT/UPDATE だけでなく DELETE も失敗**します（DELETE も storage を増やすため）。n8n は実行履歴を DB に貯めるので、**詰んでからでは回復が困難**です。データ自体は消えません。

### 推奨構成（将来 Postgres を使う場合）

| 項目 | 推奨 | 理由 |
|---|---|---|
| プラン | **Launch** | Free は 400 時間で枯渇、0.5GB も狭すぎる |
| リージョン | **`aws-ap-southeast-1`** | アジア唯一 |
| compute | **0.25 CU 固定**（min=max） | 課金が読める。常時起動で約 $19.35/月 |
| 接続先 | **direct（`-pooler` なし）** | 素の `SET` 問題の回避 |
| `DB_POSTGRESDB_SSL_ENABLED` | **`true`**（必須） | 既定 `false` では繋がらない |
| `DB_PING_INTERVAL_SECONDS` | **2（既定のまま）** | 変えても節約にならない |
| 実行履歴 | プルーニング必須 | storage 課金と Free の 0.5GB 制約 |

**出典**: [Neon monitor.rs](https://github.com/neondatabase/neon/blob/main/compute_tools/src/monitor.rs) / [Plans](https://neon.com/docs/introduction/plans) / [Connection pooling](https://neon.com/docs/connect/connection-pooling) / [Manage computes](https://neon.com/docs/manage/computes) / [Regions](https://neon.com/docs/introduction/regions) / [Scale to Zero](https://neon.com/docs/introduction/scale-to-zero)
