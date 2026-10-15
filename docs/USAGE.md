# edgeflow 利用手順

edgeflow は Cloudflare Workers、Workflows、D1、R2 上で定期バッチを実行します。
現時点では定義を JSON で作成し、D1 に直接登録します。公開前に Worker を
Cloudflare Access などで保護してください。

## ノード

| type | 必須パラメータ | 任意パラメータ |
|---|---|---|
| `http` | `url` | `method`（既定 `GET`）、`headers`、`body` |
| `transform` | `value` | なし |
| `if` | `condition` | なし |
| `notify` | `webhookUrl`（HTTPS 必須）、`text` | なし |

## 式

文字列全体または文字列中の `{{ ... }}` で式を使えます。

| 変数 | 内容 |
|---|---|
| `$json` | 直前のノード出力 |
| `$nodes['ノード名']` | 実行済みの任意ノードの出力 |
| `$secrets.NAME` | Wrangler Secret |
| `$now.iso` / `$now.date` | 実行開始時刻（全ノードで同一） |
| `$run.id` / `$run.workflowName` | 実行 ID / ワークフロー名 |

`http` ノードの出力は `{ status, headers, body }` です。その直後では、たとえば
`{{ $json.body.items.length }}` のように参照できます。

## セットアップとデプロイ

```bash
npm install
npm run db:migrate:remote
npx wrangler secret put DISCORD_WEBHOOK_URL
npm run deploy
```

サンプル定義は `fixtures/daily-report.json` にあります。Wrangler の SQL から
`readfile()` を使えない環境もあるため、次のコマンドは JSON を安全に SQL 文字列へ
変換して登録します。

```bash
DEFINITION="$(node -e "const fs=require('node:fs'); const s=fs.readFileSync('fixtures/daily-report.json','utf8'); process.stdout.write(s.replaceAll(\"'\", \"''\"))")"
npx wrangler d1 execute DB --remote --command \
  "INSERT INTO workflows (id,name,definition,cron,enabled,updated_at) VALUES ('daily-report','daily-report','$DEFINITION','0 9 * * *',1,datetime('now'))"
```

Discord のWebhook URLはリポジトリやワークフロー定義へ直接書かず、上記Secretへ登録します。
Discord通知では意図しない `@everyone` などを防ぐため、メンション解釈を無効化します。

`wrangler.jsonc` の Cron Trigger は15分ごとに起動します。D1 の `cron` 列が設定された
有効なワークフローが対象です。現在は D1 側の cron 式を個別評価しないため、登録した
すべての cron ワークフローが15分ごとに実行されます。

## 手動実行

```bash
curl -X POST https://edgeflow.<subdomain>.workers.dev/runs \
  -H 'content-type: application/json' \
  -d '{"workflowId":"daily-report"}'
```

成功すると HTTP 202 と `{ "runId": "..." }` が返ります。

## 履歴の確認

```sql
SELECT id, status, started_at, finished_at, error_summary
FROM runs
WHERE workflow_id = 'daily-report'
ORDER BY started_at DESC
LIMIT 10;

SELECT node_name, status, attempts, duration_ms,
       substr(output_preview, 1, 120) AS preview, error
FROM run_steps
WHERE run_id = '<RUN_ID>';
```

たとえば Wrangler からは次のように実行できます。

```bash
npx wrangler d1 execute DB --remote --command \
  "SELECT id,status,started_at,finished_at,error_summary FROM runs WHERE workflow_id='daily-report' ORDER BY started_at DESC LIMIT 10"
```

## 制約

- Postgres など生 TCP を必要とするノードは Workers の制約により利用できません。
- `step.do()` の戻り値には 1 MiB 上限があります。edgeflow は 512 KiB を超える出力を
  R2 に退避します。
- 同時アウトバウンド接続数を超えないよう、現状はノードを直列実行します。
- `POST /runs` 自体に認証はありません。Cloudflare Access で保護する前提です。
