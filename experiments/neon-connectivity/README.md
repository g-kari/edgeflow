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
