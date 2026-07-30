# edgeflow ワークフロー実行エンジン 実装計画

> **エージェント作業者へ:** 必須サブスキル: `superpowers:subagent-driven-development`（推奨）または `superpowers:executing-plans` を使い、タスク単位で実装すること。ステップはチェックボックス（`- [ ]`）で進捗管理する。

**ゴール:** cron で定期バッチが実際に回り、実行履歴が D1 に残るワークフロー実行エンジンを Cloudflare Workers 上に作る。

**アーキテクチャ:** 単一 Worker に cron ハンドラ・手動実行エンドポイント・`WorkflowEntrypoint` を同居させる。ワークフローのノード 1 つを Cloudflare Workflows の `step.do()` 1 つに対応させ、リトライと永続化を基盤に委譲する。式評価は `new Function` を使わず、`@n8n/tournament` が生成した JS ソースを `esprima-next` で AST 化してツリーウォークで解釈する。

**技術スタック:** TypeScript / Cloudflare Workers / Cloudflare Workflows / D1 / R2 / Zod / Vitest + `@cloudflare/vitest-pool-workers` / `@n8n/tournament` / `esprima-next`

設計仕様: [`docs/superpowers/specs/2026-07-30-workflow-engine-design.md`](../specs/2026-07-30-workflow-engine-design.md)

## Global Constraints

すべてのタスクの要件に暗黙的に含まれる。

- `compatibility_date` は **`2025-09-15`**、`compatibility_flags` は **`["nodejs_compat"]`**
- **esbuild で事前バンドルしない。** wrangler に直接バンドルさせる（`main` にソースを指定）。Node 組み込みを `external` にするとネストした `require()` が `Dynamic require of "assert" is not supported` で失敗する
- **`new Function` / `eval` を使わない。** Workers はリクエスト処理中の動的コード生成を禁止している
- **`n8n-workflow` に依存しない。** 実行時依存は `@n8n/tournament`（Apache-2.0）と `esprima-next`（BSD-2-Clause）と `zod` のみ
- バンドルサイズ上限 **gzip 10 MB**、startup 上限 **1 秒**。各タスクの最後に `npx wrangler deploy --dry-run --outdir=dist` で計測し、計画末尾の記録表に追記する
- `step.do()` の戻り値は **1 MiB 上限**。512 KB 超は R2 に退避する
- 同時アウトバウンド接続は **6**。本計画の範囲では並列 `fetch` を行わない
- D1 は **DB 単位でシングルスレッド**。重いクエリを書かない
- コミットメッセージは日本語で書く

---

## ファイル構成

| ファイル | 責務 |
|---|---|
| `src/interpreter.ts` | ツリーウォーク型 JS インタプリタ。AST を同期評価する |
| `src/expression.ts` | 式のコンパイルとキャッシュ、変数バインディング |
| `src/schema.ts` | ワークフロー定義の Zod スキーマとグラフ健全性検証 |
| `src/graph.ts` | 辺の活性化による実行順の決定 |
| `src/nodes/types.ts` | `NodeContext` / `NodeResult` / `NodeImpl` |
| `src/nodes/transform.ts` | 変換ノード |
| `src/nodes/if.ts` | 分岐ノード |
| `src/nodes/http.ts` | HTTP ノード |
| `src/nodes/notify.ts` | 通知ノード |
| `src/nodes/index.ts` | ノードレジストリ |
| `src/errors.ts` | リトライ可否を持つエラー型 |
| `src/storage.ts` | D1 記録と R2 退避 |
| `src/workflow.ts` | `WorkflowEntrypoint` |
| `src/index.ts` | cron ハンドラと手動実行エンドポイント |
| `migrations/0001_init.sql` | D1 スキーマ |

---

## Task 1: プロジェクト初期化とデプロイ確認

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `src/index.ts`, `test/smoke.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `Env` 型（`DB: D1Database`, `BUCKET: R2Bucket`）、動作する Worker の骨格

- [ ] **Step 1: package.json を作る**

```json
{
  "name": "edgeflow",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "size": "wrangler deploy --dry-run --outdir=dist",
    "startup": "wrangler check startup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:migrate": "wrangler d1 migrations apply DB --local",
    "db:migrate:remote": "wrangler d1 migrations apply DB --remote"
  },
  "dependencies": {
    "@n8n/tournament": "1.8.1",
    "esprima-next": "5.8.4",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.6.0",
    "@cloudflare/workers-types": "^4.20250909.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "wrangler": "^4.115.0"
  }
}
```

- [ ] **Step 2: tsconfig.json を作る**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowJs": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: D1 データベースを作る**

Run: `npx wrangler d1 create edgeflow`

出力される `database_id` を次のステップで使う。

- [ ] **Step 4: wrangler.jsonc を作る**

`<DATABASE_ID>` は Step 3 の出力に置き換える。

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "edgeflow",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-15",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "edgeflow", "database_id": "<DATABASE_ID>" }
  ],
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "edgeflow-payloads" }
  ],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": [] }]
}
```

- [ ] **Step 5: R2 バケットを作る**

Run: `npx wrangler r2 bucket create edgeflow-payloads`

- [ ] **Step 6: vitest.config.ts を作る**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { compatibilityFlags: ['nodejs_compat'] },
      },
    },
  },
});
```

- [ ] **Step 7: 失敗するテストを書く**

`test/smoke.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('ヘルスチェックが 200 と ok を返す', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('D1 バインディングが使える', async () => {
    const r = await env.DB.prepare('SELECT 1 AS n').first<{ n: number }>();
    expect(r?.n).toBe(1);
  });

  it('R2 バインディングが使える', async () => {
    await env.BUCKET.put('smoke.txt', 'hello');
    const obj = await env.BUCKET.get('smoke.txt');
    expect(await obj?.text()).toBe('hello');
  });
});
```

- [ ] **Step 8: テストを実行して失敗を確認**

Run: `npm test`
Expected: FAIL（`src/index.ts` が存在しないためモジュール解決エラー）

- [ ] **Step 9: 最小の Worker を実装**

`src/index.ts`:

```ts
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 10: テストを実行して成功を確認**

Run: `npm test`
Expected: 3 件すべて PASS

- [ ] **Step 11: バンドルサイズと startup を計測**

Run: `npm run size`
記録: `Total Upload` の gzip 値を計画末尾の表に書く。

Run: `npm run startup`
記録: 生成された `worker-startup.cpuprofile` から総時間を求める。

```bash
node -e "const p=require('./worker-startup.cpuprofile');console.log(((p.endTime-p.startTime)/1000).toFixed(1)+' ms')"
```

- [ ] **Step 12: .gitignore を作ってコミット**

```
node_modules/
dist/
.wrangler/
*.cpuprofile
.dev.vars
```

```bash
git add package.json tsconfig.json wrangler.jsonc vitest.config.ts src/index.ts test/smoke.test.ts .gitignore
git commit -m "プロジェクト初期化: Worker 骨格と D1/R2 バインディング"
```

---

## Task 2: 式インタプリタの移植

`experiments/single-worker-interpreter/interpreter.js` を TypeScript に移植する。**ロジックは変更しない。** 型を付け、`$` 変数の解決だけ確認する。

**Files:**
- Create: `src/interpreter.ts`, `test/interpreter.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `compile(code: string): CompiledExpression`、`run(compiled: CompiledExpression, data: unknown, onError: (e: unknown) => void): unknown`

- [ ] **Step 1: 失敗するテストを書く**

`test/interpreter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compile, run } from '../src/interpreter';

const evalCode = (code: string, data: unknown = {}) => {
  const errors: string[] = [];
  const value = run(compile(code), data, (e) => errors.push(String((e as Error)?.message ?? e)));
  return { value, errors };
};

describe('interpreter', () => {
  it('算術を評価する', () => {
    expect(evalCode('return 1 + 2;').value).toBe(3);
  });

  it('this からプロパティを読む', () => {
    expect(evalCode('return this.name;', { name: 'gizen' }).value).toBe('gizen');
  });

  it('アロー関数とクロージャが動く', () => {
    const code = 'var n = this.n; return [1,2,3].map(x => x + n).join("-");';
    expect(evalCode(code, { n: 7 }).value).toBe('8-9-10');
  });

  it('オプショナルチェーンと ?? が動く', () => {
    expect(evalCode('return this.a?.b ?? "fallback";', {}).value).toBe('fallback');
  });

  it('テンプレートリテラルが動く', () => {
    expect(evalCode('return `n=${this.n}`;', { n: 5 }).value).toBe('n=5');
  });

  it('SAFE_GLOBALS の Boolean が使える', () => {
    expect(evalCode('return [0,1,2].filter(Boolean).length;').value).toBe(2);
  });

  it('constructor へのアクセスを遮断する', () => {
    expect(() => run(compile('return this.constructor;'), {}, () => {})).toThrow(/security concerns/);
  });

  it('__proto__ へのアクセスを遮断する', () => {
    expect(() => run(compile('return ({}).__proto__;'), {}, () => {})).toThrow(/security concerns/);
  });

  it('globalThis に到達できない', () => {
    expect(() => run(compile('return globalThis;'), {}, () => {})).toThrow(/not defined/);
  });

  it('未対応構文は拒否する', () => {
    expect(() => run(compile('for (;;) {}'), {}, () => {})).toThrow(/unsupported statement node/);
  });

  it('try/catch でエラーハンドラが呼ばれる', () => {
    const r = evalCode('try { return this.a.b; } catch (e) { E(e, this); }', {});
    expect(r.value).toBeUndefined();
    expect(r.errors.length).toBe(1);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run test/interpreter.test.ts`
Expected: FAIL（`src/interpreter.ts` が存在しない）

- [ ] **Step 3: interpreter.ts を作る**

`experiments/single-worker-interpreter/interpreter.js` をコピーして `src/interpreter.ts` にし、以下の型を追加する。**ロジック本体（`Scope`, `member`, `BINARY`, `UNARY`, `evaluate`, `bindPattern`, `execute`）は一字も変えない。**

```bash
cp experiments/single-worker-interpreter/interpreter.js src/interpreter.ts
```

ファイル冒頭の import を変え、末尾の公開 API に型を付ける。

```ts
// 冒頭
import * as esprima from 'esprima-next';

export type CompiledExpression = {
  params: unknown[];
  body: unknown;
};

// 末尾（既存の compile / run を置き換える）
export function compile(code: string): CompiledExpression {
  const program = esprima.parseScript(`(function(E){${code}\n})`) as any;
  const fnNode = program.body[0].expression;
  return { params: fnNode.params, body: fnNode.body };
}

export function run(
  compiled: CompiledExpression,
  data: unknown,
  onError: (e: unknown) => void,
): unknown {
  const scope = new Scope(null, data);
  scope.declare('E', onError);
  const r = execute(compiled.body as any, scope);
  return r && (r as any)[RETURN] ? (r as any).value : undefined;
}
```

内部関数の引数には `any` を許す。AST ノードの厳密な型付けは費用対効果が悪く、テストで振る舞いを保証する方針を採る。ファイル先頭に理由を書く。

```ts
// AST ノードは esprima の構造をそのまま扱うため内部では any を使う。
// 厳密な型付けより、test/interpreter.test.ts による振る舞いの保証を優先する。
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run test/interpreter.test.ts`
Expected: 11 件すべて PASS

- [ ] **Step 5: 型チェックを通す**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "式インタプリタを TypeScript に移植"
```

---

## Task 3: 式評価層

`@n8n/tournament` でテンプレートを JS ソースに変換し、インタプリタで評価する層を作る。コンパイル結果をキャッシュする。

**Files:**
- Create: `src/expression.ts`, `test/expression.test.ts`

**Interfaces:**
- Consumes: `compile` / `run` / `CompiledExpression`（Task 2）
- Produces:
  - `type ExpressionScope = { $json: unknown; $nodes: Record<string, unknown>; $secrets: Record<string, string>; $now: { iso: string; date: Date }; $run: { id: string; workflowName: string; attempt: number } }`
  - `class ExpressionEvaluator { evaluate(template: string, scope: ExpressionScope): unknown }`

- [ ] **Step 1: 失敗するテストを書く**

`test/expression.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ExpressionEvaluator, type ExpressionScope } from '../src/expression';

const scope = (over: Partial<ExpressionScope> = {}): ExpressionScope => ({
  $json: { name: 'gizen', n: 7, items: [{ ok: true }, { ok: false }, { ok: true }] },
  $nodes: { Fetch: { body: { total: 100 } } },
  $secrets: { SLACK_TOKEN: 'xoxb-test' },
  $now: { iso: '2026-07-30T00:00:00.000Z', date: new Date('2026-07-30T00:00:00.000Z') },
  $run: { id: 'run-1', workflowName: 'demo', attempt: 1 },
  ...over,
});

describe('ExpressionEvaluator', () => {
  it('算術式を評価する', () => {
    expect(new ExpressionEvaluator().evaluate('{{ 1 + 2 }}', scope())).toBe(3);
  });

  it('$json を読む', () => {
    expect(new ExpressionEvaluator().evaluate('{{ $json.name }}', scope())).toBe('gizen');
  });

  it('文字列補間ができる', () => {
    const r = new ExpressionEvaluator().evaluate('Hello {{ $json.name }}, {{ $json.n * 2 }}', scope());
    expect(r).toBe('Hello gizen, 14');
  });

  it('配列操作ができる', () => {
    const r = new ExpressionEvaluator().evaluate('{{ $json.items.filter(i => i.ok).length }}', scope());
    expect(r).toBe(2);
  });

  it('$nodes を名前で読む', () => {
    expect(new ExpressionEvaluator().evaluate("{{ $nodes['Fetch'].body.total }}", scope())).toBe(100);
  });

  it('$secrets を読む', () => {
    expect(new ExpressionEvaluator().evaluate('{{ $secrets.SLACK_TOKEN }}', scope())).toBe('xoxb-test');
  });

  it('$now を読む', () => {
    expect(new ExpressionEvaluator().evaluate('{{ $now.iso }}', scope())).toBe('2026-07-30T00:00:00.000Z');
  });

  it('同じテンプレートを再評価してもキャッシュが効く', () => {
    const ev = new ExpressionEvaluator();
    expect(ev.evaluate('{{ $json.n }}', scope())).toBe(7);
    expect(ev.evaluate('{{ $json.n }}', scope({ $json: { n: 99 } }))).toBe(99);
    expect(ev.cacheSize).toBe(1);
  });

  it('危険な式は ExpressionError を投げる', () => {
    const ev = new ExpressionEvaluator();
    expect(() => ev.evaluate('{{ $json.constructor }}', scope())).toThrow(/security concerns/);
  });

  it('評価中のエラーは ExpressionError にまとめて投げる', () => {
    const ev = new ExpressionEvaluator();
    expect(() => ev.evaluate('{{ $json.missing.deep }}', scope())).toThrow(/式の評価に失敗/);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run test/expression.test.ts`
Expected: FAIL（`src/expression.ts` が存在しない）

- [ ] **Step 3: expression.ts を実装**

```ts
import { Tournament } from '@n8n/tournament';
import { compile, run, type CompiledExpression } from './interpreter';

export type ExpressionScope = {
  $json: unknown;
  $nodes: Record<string, unknown>;
  $secrets: Record<string, string>;
  $now: { iso: string; date: Date };
  $run: { id: string; workflowName: string; attempt: number };
};

export class ExpressionError extends Error {
  constructor(message: string, readonly template: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// tournament は $ 接頭辞の識別子を ("$x" in this ? this : global).$x に変換する。
// したがってスコープをそのまま this として渡せば解決される。
// n8n の AST サニタイザは使わない。プロトタイプ汚染は interpreter の
// BLOCKED_KEYS が実行時に遮断し、グローバルは SAFE_GLOBALS の allowlist に限られる。
export class ExpressionEvaluator {
  private readonly tournament = new Tournament();
  private readonly cache = new Map<string, CompiledExpression>();

  get cacheSize(): number {
    return this.cache.size;
  }

  evaluate(template: string, scope: ExpressionScope): unknown {
    const compiled = this.getCompiled(template);
    const errors: unknown[] = [];
    const value = run(compiled, scope, (e) => errors.push(e));
    if (errors.length > 0) {
      const first = errors[0] as Error;
      throw new ExpressionError(`式の評価に失敗しました: ${first?.message ?? String(first)}`, template);
    }
    return value;
  }

  private getCompiled(template: string): CompiledExpression {
    const hit = this.cache.get(template);
    if (hit) return hit;
    const [code] = this.tournament.getExpressionCode(template);
    const compiled = compile(code);
    this.cache.set(template, compiled);
    return compiled;
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run test/expression.test.ts`
Expected: 10 件すべて PASS

危険な式のテストが `security concerns` ではなく `式の評価に失敗` で落ちる場合、`interpreter.ts` の `member()` が投げた例外が `try/catch` で `E` に渡っている。その場合はテスト側の期待を `/security concerns/` のまま保ち、`ExpressionEvaluator.evaluate` が投げるメッセージに元の文言を含めているので通る。通らなければ `ExpressionError` のメッセージ組み立てを見直す。

- [ ] **Step 5: バンドルサイズを計測**

Run: `npm run size`
`@n8n/tournament` と `esprima-next` が入るため増える。gzip 値を記録表に追記する。

- [ ] **Step 6: コミット**

```bash
git add src/expression.ts test/expression.test.ts
git commit -m "式評価層: tournament とインタプリタを接続しキャッシュを追加"
```

---

## Task 4: ワークフロー定義スキーマと検証

**Files:**
- Create: `src/schema.ts`, `test/schema.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - 型 `Workflow`, `WorkflowNode`, `Edge`, `ParamValue`
  - `workflowSchema: z.ZodType<Workflow>`
  - `parseWorkflow(input: unknown): Workflow`（Zod 検証 + グラフ健全性検証。失敗時 `SchemaError`）
  - `class SchemaError extends Error`

- [ ] **Step 1: 失敗するテストを書く**

`test/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseWorkflow, SchemaError } from '../src/schema';

const base = () => ({
  schemaVersion: 1,
  id: 'wf-1',
  name: 'demo',
  trigger: { type: 'cron', cron: '0 9 * * *' },
  nodes: [
    { id: 'a', type: 'http', name: 'Fetch', params: { url: 'https://example.com' } },
    { id: 'b', type: 'transform', name: 'Pick', params: { value: { $expr: '{{ $json.body }}' } } },
  ],
  edges: [{ from: 'a', to: 'b' }],
});

describe('parseWorkflow', () => {
  it('正しい定義を通す', () => {
    const wf = parseWorkflow(base());
    expect(wf.name).toBe('demo');
    expect(wf.nodes).toHaveLength(2);
  });

  it('schemaVersion が 1 でなければ拒否する', () => {
    expect(() => parseWorkflow({ ...base(), schemaVersion: 2 })).toThrow(SchemaError);
  });

  it('エントリノードが 0 個なら拒否する', () => {
    const wf = base();
    wf.edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }];
    expect(() => parseWorkflow(wf)).toThrow(/エントリノード/);
  });

  it('エントリノードが 2 個なら拒否する', () => {
    const wf = base();
    wf.edges = [];
    expect(() => parseWorkflow(wf)).toThrow(/エントリノード/);
  });

  it('存在しない from を拒否する', () => {
    const wf = base();
    wf.edges = [{ from: 'zzz', to: 'b' }];
    expect(() => parseWorkflow(wf)).toThrow(/存在しないノード/);
  });

  it('循環を拒否する', () => {
    const wf = base();
    wf.nodes.push({ id: 'c', type: 'transform', name: 'C', params: {} });
    wf.edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }];
    expect(() => parseWorkflow(wf)).toThrow(/循環/);
  });

  it('到達不能ノードを拒否する', () => {
    const wf = base();
    wf.nodes.push({ id: 'c', type: 'transform', name: 'Orphan', params: {} });
    expect(() => parseWorkflow(wf)).toThrow(/到達不能/);
  });

  it('if 以外への branch を拒否する', () => {
    const wf = base();
    wf.edges = [{ from: 'a', to: 'b', branch: 'true' }];
    expect(() => parseWorkflow(wf)).toThrow(/branch/);
  });

  it('重複した Node.name を拒否する', () => {
    const wf = base();
    wf.nodes[1]!.name = 'Fetch';
    expect(() => parseWorkflow(wf)).toThrow(/name が重複/);
  });

  it('重複した Node.id を拒否する', () => {
    const wf = base();
    wf.nodes[1]!.id = 'a';
    expect(() => parseWorkflow(wf)).toThrow(/id が重複/);
  });

  it('$expr パラメータを受け付ける', () => {
    const wf = parseWorkflow(base());
    expect(wf.nodes[1]!.params.value).toEqual({ $expr: '{{ $json.body }}' });
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL

- [ ] **Step 3: schema.ts を実装**

```ts
import { z } from 'zod';

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

const literalSchema: z.ZodType<Literal> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(literalSchema),
    z.record(literalSchema),
  ]),
);

export type Literal =
  | string | number | boolean | null
  | Literal[]
  | { [k: string]: Literal };

export type ParamValue = Literal | { $expr: string };

const paramValueSchema: z.ZodType<ParamValue> = z.union([
  z.object({ $expr: z.string() }).strict(),
  literalSchema,
]);

export const NODE_TYPES = ['http', 'transform', 'if', 'notify'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  name: z.string().min(1),
  params: z.record(paramValueSchema),
  retry: z.object({ limit: z.number().int().min(0).max(10) }).optional(),
});

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  branch: z.enum(['true', 'false']).optional(),
});

export const workflowSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  trigger: z.union([
    z.object({ type: z.literal('cron'), cron: z.string().min(1) }),
    z.object({ type: z.literal('manual') }),
  ]),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema),
  defaultRetryLimit: z.number().int().min(0).max(10).optional(),
});

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type Edge = z.infer<typeof edgeSchema>;

export function parseWorkflow(input: unknown): Workflow {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    throw new SchemaError(`定義の形式が不正です: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  const wf = parsed.data;
  validateGraph(wf);
  return wf;
}

function validateGraph(wf: Workflow): void {
  const byId = new Map<string, WorkflowNode>();
  for (const n of wf.nodes) {
    if (byId.has(n.id)) throw new SchemaError(`Node の id が重複しています: ${n.id}`);
    byId.set(n.id, n);
  }

  const names = new Set<string>();
  for (const n of wf.nodes) {
    if (names.has(n.name)) throw new SchemaError(`Node の name が重複しています: ${n.name}`);
    names.add(n.name);
  }

  for (const e of wf.edges) {
    if (!byId.has(e.from)) throw new SchemaError(`存在しないノードを参照しています: ${e.from}`);
    if (!byId.has(e.to)) throw new SchemaError(`存在しないノードを参照しています: ${e.to}`);
    if (e.branch && byId.get(e.from)!.type !== 'if') {
      throw new SchemaError(`branch は if ノードの出力辺にのみ指定できます: ${e.from}`);
    }
  }

  const inbound = new Map<string, number>(wf.nodes.map((n) => [n.id, 0]));
  for (const e of wf.edges) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
  const entries = wf.nodes.filter((n) => (inbound.get(n.id) ?? 0) === 0);
  if (entries.length !== 1) {
    throw new SchemaError(`エントリノードはちょうど 1 つ必要です（現在 ${entries.length} 個）`);
  }

  detectCycle(wf, byId);
  detectUnreachable(wf, entries[0]!.id, byId);
}

function detectCycle(wf: Workflow, byId: Map<string, WorkflowNode>): void {
  const out = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) out.get(e.from)!.push(e.to);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(wf.nodes.map((n) => [n.id, WHITE]));

  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const next of out.get(id) ?? []) {
      const c = color.get(next);
      if (c === GRAY) throw new SchemaError(`グラフに循環があります: ${id} → ${next}`);
      if (c === WHITE) visit(next);
    }
    color.set(id, BLACK);
  };

  for (const n of byId.keys()) if (color.get(n) === WHITE) visit(n);
}

function detectUnreachable(wf: Workflow, entryId: string, byId: Map<string, WorkflowNode>): void {
  const out = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) out.get(e.from)!.push(e.to);

  const seen = new Set<string>([entryId]);
  const stack = [entryId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of out.get(id) ?? []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }

  for (const id of byId.keys()) {
    if (!seen.has(id)) throw new SchemaError(`到達不能なノードがあります: ${id}`);
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run test/schema.test.ts`
Expected: 11 件すべて PASS

- [ ] **Step 5: コミット**

```bash
git add src/schema.ts test/schema.test.ts
git commit -m "ワークフロー定義スキーマとグラフ健全性検証"
```

---

## Task 5: グラフ走査

辺の活性化で実行順を決める純関数を作る。

**Files:**
- Create: `src/graph.ts`, `test/graph.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `WorkflowNode`（Task 4）
- Produces:
  - `type StepOutcome = { branch?: 'true' | 'false' }`
  - `class ExecutionPlanner`
    - `constructor(wf: Workflow)`
    - `next(): WorkflowNode | null` — 次に実行すべきノード。なければ `null`
    - `complete(nodeId: string, outcome: StepOutcome): void` — 実行結果を反映して辺を活性化
    - `skipped(): string[]` — 走査完了後、到達しなかったノード ID

- [ ] **Step 1: 失敗するテストを書く**

`test/graph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ExecutionPlanner } from '../src/graph';
import { parseWorkflow, type Workflow } from '../src/schema';

const wf = (nodes: any[], edges: any[]): Workflow =>
  parseWorkflow({
    schemaVersion: 1, id: 'w', name: 'w',
    trigger: { type: 'manual' }, nodes, edges,
  });

const n = (id: string, type = 'transform') => ({ id, type, name: id.toUpperCase(), params: {} });

const runAll = (w: Workflow, outcomes: Record<string, 'true' | 'false'> = {}) => {
  const p = new ExecutionPlanner(w);
  const order: string[] = [];
  let node = p.next();
  while (node) {
    order.push(node.id);
    p.complete(node.id, { branch: outcomes[node.id] });
    node = p.next();
  }
  return { order, skipped: p.skipped() };
};

describe('ExecutionPlanner', () => {
  it('一直線のグラフを順に返す', () => {
    const w = wf([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    expect(runAll(w).order).toEqual(['a', 'b', 'c']);
  });

  it('分岐で true 側だけ通る', () => {
    const w = wf(
      [n('a', 'if'), n('t'), n('f')],
      [{ from: 'a', to: 't', branch: 'true' }, { from: 'a', to: 'f', branch: 'false' }],
    );
    const r = runAll(w, { a: 'true' });
    expect(r.order).toEqual(['a', 't']);
    expect(r.skipped).toEqual(['f']);
  });

  it('選ばれなかった側の下流もスキップになる', () => {
    const w = wf(
      [n('a', 'if'), n('t'), n('f'), n('f2')],
      [
        { from: 'a', to: 't', branch: 'true' },
        { from: 'a', to: 'f', branch: 'false' },
        { from: 'f', to: 'f2' },
      ],
    );
    const r = runAll(w, { a: 'true' });
    expect(r.order).toEqual(['a', 't']);
    expect(r.skipped.sort()).toEqual(['f', 'f2']);
  });

  it('対応する branch の辺が無ければ正常終了する', () => {
    const w = wf([n('a', 'if'), n('t')], [{ from: 'a', to: 't', branch: 'true' }]);
    const r = runAll(w, { a: 'false' });
    expect(r.order).toEqual(['a']);
    expect(r.skipped).toEqual(['t']);
  });

  it('合流したノードは 1 回だけ実行される', () => {
    const w = wf(
      [n('a', 'if'), n('t'), n('f'), n('m')],
      [
        { from: 'a', to: 't', branch: 'true' },
        { from: 'a', to: 'f', branch: 'false' },
        { from: 't', to: 'm' },
        { from: 'f', to: 'm' },
      ],
    );
    const r = runAll(w, { a: 'true' });
    expect(r.order).toEqual(['a', 't', 'm']);
    expect(r.skipped).toEqual(['f']);
  });

  it('走査完了後は next() が null を返す', () => {
    const w = wf([n('a')], []);
    const p = new ExecutionPlanner(w);
    expect(p.next()!.id).toBe('a');
    p.complete('a', {});
    expect(p.next()).toBeNull();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run test/graph.test.ts`
Expected: FAIL

- [ ] **Step 3: graph.ts を実装**

```ts
import type { Edge, Workflow, WorkflowNode } from './schema';

export type StepOutcome = { branch?: 'true' | 'false' };

export class ExecutionPlanner {
  private readonly byId = new Map<string, WorkflowNode>();
  private readonly outEdges = new Map<string, Edge[]>();
  private readonly inEdgeCount = new Map<string, number>();
  private readonly activatedInbound = new Map<string, number>();
  private readonly executed = new Set<string>();
  private readonly ready: string[] = [];

  constructor(private readonly wf: Workflow) {
    for (const node of wf.nodes) {
      this.byId.set(node.id, node);
      this.outEdges.set(node.id, []);
      this.inEdgeCount.set(node.id, 0);
      this.activatedInbound.set(node.id, 0);
    }
    for (const e of wf.edges) {
      this.outEdges.get(e.from)!.push(e);
      this.inEdgeCount.set(e.to, this.inEdgeCount.get(e.to)! + 1);
    }
    for (const node of wf.nodes) {
      if (this.inEdgeCount.get(node.id) === 0) this.ready.push(node.id);
    }
  }

  next(): WorkflowNode | null {
    const id = this.ready.shift();
    if (id === undefined) return null;
    return this.byId.get(id)!;
  }

  complete(nodeId: string, outcome: StepOutcome): void {
    this.executed.add(nodeId);
    const node = this.byId.get(nodeId)!;
    for (const e of this.outEdges.get(nodeId)!) {
      // if ノードは結果に一致する辺だけを活性化する。
      // 一致する辺が無ければその経路はここで正常終了する。
      if (node.type === 'if' && e.branch !== outcome.branch) continue;
      this.activate(e.to);
    }
  }

  // 入力辺が 1 本でも活性化されたら実行対象にする（最大 1 回）。
  private activate(nodeId: string): void {
    const count = this.activatedInbound.get(nodeId)! + 1;
    this.activatedInbound.set(nodeId, count);
    if (count === 1 && !this.executed.has(nodeId) && !this.ready.includes(nodeId)) {
      this.ready.push(nodeId);
    }
  }

  skipped(): string[] {
    return this.wf.nodes.filter((n) => !this.executed.has(n.id)).map((n) => n.id);
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run test/graph.test.ts`
Expected: 6 件すべて PASS

- [ ] **Step 5: コミット**

```bash
git add src/graph.ts test/graph.test.ts
git commit -m "グラフ走査: 辺の活性化による実行順決定とスキップ判定"
```

---

## Task 6: エラー型とノード基盤、transform / if ノード

**Files:**
- Create: `src/errors.ts`, `src/nodes/types.ts`, `src/nodes/transform.ts`, `src/nodes/if.ts`, `src/nodes/index.ts`, `test/nodes-pure.test.ts`

**Interfaces:**
- Consumes: `ExpressionScope`（Task 3）
- Produces:
  - `class NonRetryableError extends Error`
  - `type NodeContext = { params: Record<string, unknown>; input: unknown; run: RunMeta }`
  - `type RunMeta = { id: string; workflowName: string; attempt: number; now: { iso: string; date: Date } }`
  - `type NodeResult = { output: unknown; branch?: 'true' | 'false' }`
  - `type NodeImpl = (ctx: NodeContext) => Promise<NodeResult>`
  - `const NODE_IMPLS: Record<NodeType, NodeImpl>`

- [ ] **Step 1: 失敗するテストを書く**

`test/nodes-pure.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NODE_IMPLS } from '../src/nodes';
import { NonRetryableError } from '../src/errors';
import type { NodeContext } from '../src/nodes/types';

const ctx = (params: Record<string, unknown>, input: unknown = {}): NodeContext => ({
  params,
  input,
  run: { id: 'r1', workflowName: 'w', attempt: 1, now: { iso: '2026-07-30T00:00:00.000Z', date: new Date(0) } },
});

describe('transform ノード', () => {
  it('解決済みの value をそのまま返す', async () => {
    const r = await NODE_IMPLS.transform(ctx({ value: 42 }));
    expect(r.output).toBe(42);
  });

  it('value が無ければ NonRetryableError', async () => {
    await expect(NODE_IMPLS.transform(ctx({}))).rejects.toThrow(NonRetryableError);
  });
});

describe('if ノード', () => {
  it('真値なら branch=true、入力を透過する', async () => {
    const r = await NODE_IMPLS.if(ctx({ condition: true }, { a: 1 }));
    expect(r.branch).toBe('true');
    expect(r.output).toEqual({ a: 1 });
  });

  it('偽値なら branch=false', async () => {
    const r = await NODE_IMPLS.if(ctx({ condition: 0 }, { a: 1 }));
    expect(r.branch).toBe('false');
  });

  it('condition が無ければ NonRetryableError', async () => {
    await expect(NODE_IMPLS.if(ctx({}))).rejects.toThrow(NonRetryableError);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run test/nodes-pure.test.ts`
Expected: FAIL

- [ ] **Step 3: errors.ts を実装**

```ts
// リトライしても無駄なエラー。Workflows の NonRetryableError に写像する。
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

// HTTP ステータスからリトライ可否を判定する。
// 429 は一時的な制限なのでリトライする。他の 4xx は投げ直しても結果が変わらない。
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500;
}
```

- [ ] **Step 4: nodes/types.ts を実装**

```ts
export type RunMeta = {
  id: string;
  workflowName: string;
  attempt: number;
  now: { iso: string; date: Date };
};

export type NodeContext = {
  /** 式は解決済み。ノード実装は $expr の存在を知らない。 */
  params: Record<string, unknown>;
  /** 直前のノードの出力（$json） */
  input: unknown;
  run: RunMeta;
};

export type NodeResult = {
  output: unknown;
  /** if ノードのみが設定する */
  branch?: 'true' | 'false';
};

export type NodeImpl = (ctx: NodeContext) => Promise<NodeResult>;

export function requireParam(ctx: NodeContext, key: string): unknown {
  if (!(key in ctx.params)) {
    throw new NonRetryableError(`必須パラメータがありません: ${key}`);
  }
  return ctx.params[key];
}

import { NonRetryableError } from '../errors';
```

`import` は先頭に移すこと。

- [ ] **Step 5: transform.ts と if.ts を実装**

`src/nodes/transform.ts`:

```ts
import { requireParam, type NodeImpl } from './types';

// 式 1 本を評価して返すだけ。評価そのものは呼び出し側で済んでいる。
export const transformNode: NodeImpl = async (ctx) => {
  return { output: requireParam(ctx, 'value') };
};
```

`src/nodes/if.ts`:

```ts
import { requireParam, type NodeImpl } from './types';

// 条件を真偽で判定し、入力はそのまま下流へ透過する。
export const ifNode: NodeImpl = async (ctx) => {
  const condition = requireParam(ctx, 'condition');
  return { output: ctx.input, branch: condition ? 'true' : 'false' };
};
```

- [ ] **Step 6: nodes/index.ts を実装（http / notify は次タスクで追加）**

```ts
import type { NodeType } from '../schema';
import type { NodeImpl } from './types';
import { transformNode } from './transform';
import { ifNode } from './if';

export const NODE_IMPLS: Record<NodeType, NodeImpl> = {
  transform: transformNode,
  if: ifNode,
  // http と notify は Task 7 で追加する
  http: async () => { throw new Error('未実装'); },
  notify: async () => { throw new Error('未実装'); },
};

export type { NodeContext, NodeImpl, NodeResult, RunMeta } from './types';
```

- [ ] **Step 7: テストを実行して成功を確認**

Run: `npx vitest run test/nodes-pure.test.ts`
Expected: 5 件すべて PASS

- [ ] **Step 8: コミット**

```bash
git add src/errors.ts src/nodes test/nodes-pure.test.ts
git commit -m "ノード基盤と transform / if ノード"
```

---

## Task 7: http / notify ノード

**Files:**
- Create: `src/nodes/http.ts`, `src/nodes/notify.ts`, `test/nodes-fetch.test.ts`
- Modify: `src/nodes/index.ts`

**Interfaces:**
- Consumes: `NodeImpl`, `NonRetryableError`, `isRetryableStatus`（Task 6）
- Produces: `httpNode`, `notifyNode`。`httpNode` の出力は `{ status: number; headers: Record<string,string>; body: unknown }`

- [ ] **Step 1: 失敗するテストを書く**

`test/nodes-fetch.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_IMPLS } from '../src/nodes';
import { NonRetryableError } from '../src/errors';
import type { NodeContext } from '../src/nodes/types';

const ctx = (params: Record<string, unknown>, input: unknown = {}): NodeContext => ({
  params, input,
  run: { id: 'r1', workflowName: 'w', attempt: 1, now: { iso: '2026-07-30T00:00:00.000Z', date: new Date(0) } },
});

const mockFetch = (status: number, body: string, contentType = 'application/json') => {
  const spy = vi.fn(async () =>
    new Response(body, { status, headers: { 'content-type': contentType } }));
  vi.stubGlobal('fetch', spy);
  return spy;
};

afterEach(() => vi.unstubAllGlobals());

describe('http ノード', () => {
  it('JSON を parse して status/headers/body を返す', async () => {
    mockFetch(200, JSON.stringify({ items: [1, 2] }));
    const r = await NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }));
    expect(r.output).toMatchObject({ status: 200, body: { items: [1, 2] } });
  });

  it('JSON 以外は文字列で返す', async () => {
    mockFetch(200, 'plain', 'text/plain');
    const r = await NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }));
    expect((r.output as any).body).toBe('plain');
  });

  it('method と body と headers を渡す', async () => {
    const spy = mockFetch(200, '{}');
    await NODE_IMPLS.http(ctx({
      url: 'https://x.test/a', method: 'POST',
      headers: { 'x-token': 'abc' }, body: { a: 1 },
    }));
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Record<string, string>)['x-token']).toBe('abc');
  });

  it('5xx はリトライ可能な Error を投げる', async () => {
    mockFetch(503, 'oops', 'text/plain');
    await expect(NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }))).rejects.toThrow(/503/);
    await expect(NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }))).rejects.not.toThrow(NonRetryableError);
  });

  it('401 は NonRetryableError', async () => {
    mockFetch(401, 'no', 'text/plain');
    await expect(NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }))).rejects.toThrow(NonRetryableError);
  });

  it('429 はリトライ可能', async () => {
    mockFetch(429, 'slow down', 'text/plain');
    await expect(NODE_IMPLS.http(ctx({ url: 'https://x.test/a' }))).rejects.not.toThrow(NonRetryableError);
  });

  it('url が無ければ NonRetryableError', async () => {
    await expect(NODE_IMPLS.http(ctx({}))).rejects.toThrow(NonRetryableError);
  });
});

describe('notify ノード', () => {
  it('webhookUrl に text を POST する', async () => {
    const spy = mockFetch(200, 'ok', 'text/plain');
    const r = await NODE_IMPLS.notify(ctx({ webhookUrl: 'https://hooks.slack.com/x', text: 'hi' }));
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ text: 'hi' }));
    expect(r.output).toMatchObject({ status: 200 });
  });

  it('https 以外の webhookUrl を拒否する', async () => {
    await expect(NODE_IMPLS.notify(ctx({ webhookUrl: 'http://x.test/', text: 'a' })))
      .rejects.toThrow(NonRetryableError);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run test/nodes-fetch.test.ts`
Expected: FAIL（`未実装` が投げられる）

- [ ] **Step 3: http.ts を実装**

```ts
import { isRetryableStatus, NonRetryableError } from '../errors';
import { requireParam, type NodeImpl, type NodeResult } from './types';

export type HttpOutput = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export const httpNode: NodeImpl = async (ctx): Promise<NodeResult> => {
  const url = String(requireParam(ctx, 'url'));
  const method = String(ctx.params.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(ctx.params.headers as Record<string, string> ?? {}) };

  let body: string | undefined;
  if (ctx.params.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = typeof ctx.params.body === 'string'
      ? ctx.params.body
      : JSON.stringify(ctx.params.body);
    headers['content-type'] ??= 'application/json';
  }

  const res = await fetch(url, { method, headers, body });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const message = `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`;
    // 4xx（429 を除く）は投げ直しても結果が変わらないためリトライしない。
    if (!isRetryableStatus(res.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }

  return { output: await toOutput(res) };
};

async function toOutput(res: Response): Promise<HttpOutput> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await res.json() : await res.text();
  return { status: res.status, headers, body };
}
```

- [ ] **Step 4: notify.ts を実装**

```ts
import { isRetryableStatus, NonRetryableError } from '../errors';
import { requireParam, type NodeImpl } from './types';

// Slack / Discord の incoming webhook に POST する。
// 実体は http ノードのラッパだが、URL 形式を検証できる点で分けている。
export const notifyNode: NodeImpl = async (ctx) => {
  const webhookUrl = String(requireParam(ctx, 'webhookUrl'));
  const text = String(requireParam(ctx, 'text'));

  if (!webhookUrl.startsWith('https://')) {
    throw new NonRetryableError(`webhookUrl は https でなければなりません: ${webhookUrl}`);
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const message = `通知に失敗しました HTTP ${res.status}`;
    if (!isRetryableStatus(res.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }

  return { output: { status: res.status } };
};
```

- [ ] **Step 5: nodes/index.ts を更新**

```ts
import type { NodeType } from '../schema';
import type { NodeImpl } from './types';
import { transformNode } from './transform';
import { ifNode } from './if';
import { httpNode } from './http';
import { notifyNode } from './notify';

export const NODE_IMPLS: Record<NodeType, NodeImpl> = {
  transform: transformNode,
  if: ifNode,
  http: httpNode,
  notify: notifyNode,
};

export type { NodeContext, NodeImpl, NodeResult, RunMeta } from './types';
```

- [ ] **Step 6: テストを実行して成功を確認**

Run: `npx vitest run test/nodes-fetch.test.ts`
Expected: 9 件すべて PASS

- [ ] **Step 7: 全テストと型チェック**

Run: `npm test && npm run typecheck`
Expected: すべて PASS

- [ ] **Step 8: コミット**

```bash
git add src/nodes test/nodes-fetch.test.ts
git commit -m "http / notify ノードとリトライ可否の判定"
```

---

## Task 8: ストレージ層

**Files:**
- Create: `migrations/0001_init.sql`, `src/storage.ts`, `test/storage.test.ts`

**Interfaces:**
- Consumes: `Env`（Task 1）、`Workflow`（Task 4）
- Produces:
  - `type StepOutput = { kind: 'inline'; value: unknown } | { kind: 'r2'; key: string; bytes: number }`
  - `class Storage`
    - `constructor(env: Env)`
    - `loadWorkflow(id: string): Promise<Workflow>`
    - `listCronWorkflows(): Promise<Workflow[]>`
    - `startRun(runId: string, workflowId: string, triggerType: string, startedAt: string): Promise<void>`
    - `finishRun(runId: string, status: 'success' | 'failed', finishedAt: string, errorSummary?: string): Promise<void>`
    - `recordStep(runId: string, node: { id: string; name: string }, status: 'success' | 'failed' | 'skipped', info: { attempts: number; durationMs: number; output?: unknown; error?: string }): Promise<void>`
    - `saveOutput(runId: string, nodeId: string, value: unknown): Promise<StepOutput>`
    - `readOutput(out: StepOutput): Promise<unknown>`

- [ ] **Step 1: マイグレーションを書く**

`migrations/0001_init.sql`:

```sql
CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  cron        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  status        TEXT NOT NULL,
  trigger_type  TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error_summary TEXT
);

CREATE INDEX idx_runs_workflow_started ON runs (workflow_id, started_at DESC);

CREATE TABLE run_steps (
  run_id         TEXT NOT NULL,
  node_id        TEXT NOT NULL,
  node_name      TEXT NOT NULL,
  status         TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  output_preview TEXT,
  output_r2_key  TEXT,
  error          TEXT,
  PRIMARY KEY (run_id, node_id)
);
```

- [ ] **Step 2: マイグレーションを適用**

Run: `npm run db:migrate`
Expected: 3 テーブルが作成される

- [ ] **Step 3: 失敗するテストを書く**

`test/storage.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage';

const definition = {
  schemaVersion: 1, id: 'wf-1', name: 'demo',
  trigger: { type: 'cron', cron: '0 9 * * *' },
  nodes: [{ id: 'a', type: 'transform', name: 'A', params: { value: 1 } }],
  edges: [],
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM run_steps');
  await env.DB.exec('DELETE FROM runs');
  await env.DB.exec('DELETE FROM workflows');
  await env.DB.prepare(
    'INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES (?,?,?,?,1,?)',
  ).bind('wf-1', 'demo', JSON.stringify(definition), '0 9 * * *', '2026-07-30T00:00:00Z').run();
});

describe('Storage', () => {
  it('ワークフローを読み込んで検証する', async () => {
    const wf = await new Storage(env).loadWorkflow('wf-1');
    expect(wf.name).toBe('demo');
  });

  it('存在しない ID はエラー', async () => {
    await expect(new Storage(env).loadWorkflow('zzz')).rejects.toThrow(/見つかりません/);
  });

  it('cron ワークフローを列挙する', async () => {
    const list = await new Storage(env).listCronWorkflows();
    expect(list.map((w) => w.id)).toEqual(['wf-1']);
  });

  it('実行を開始して終了できる', async () => {
    const s = new Storage(env);
    await s.startRun('run-1', 'wf-1', 'cron', '2026-07-30T00:00:00Z');
    await s.finishRun('run-1', 'success', '2026-07-30T00:00:01Z');
    const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind('run-1').first();
    expect(row?.status).toBe('success');
  });

  it('小さい出力は inline で返す', async () => {
    const out = await new Storage(env).saveOutput('run-1', 'a', { a: 1 });
    expect(out.kind).toBe('inline');
    expect(await new Storage(env).readOutput(out)).toEqual({ a: 1 });
  });

  it('512KB 超の出力は R2 に退避する', async () => {
    const big = { blob: 'x'.repeat(600 * 1024) };
    const s = new Storage(env);
    const out = await s.saveOutput('run-1', 'a', big);
    expect(out.kind).toBe('r2');
    expect(await s.readOutput(out)).toEqual(big);
  });

  it('ステップを記録し preview を切り詰める', async () => {
    const s = new Storage(env);
    await s.startRun('run-1', 'wf-1', 'cron', '2026-07-30T00:00:00Z');
    await s.recordStep('run-1', { id: 'a', name: 'A' }, 'success', {
      attempts: 1, durationMs: 12, output: { text: 'y'.repeat(10_000) },
    });
    const row = await env.DB.prepare(
      'SELECT output_preview, status FROM run_steps WHERE run_id = ? AND node_id = ?',
    ).bind('run-1', 'a').first<{ output_preview: string; status: string }>();
    expect(row?.status).toBe('success');
    expect(row!.output_preview.length).toBeLessThanOrEqual(4096);
  });
});
```

- [ ] **Step 4: テストを実行して失敗を確認**

Run: `npx vitest run test/storage.test.ts`
Expected: FAIL

- [ ] **Step 5: storage.ts を実装**

`Env` は `src/index.ts` から **`import type`** で取る。`index.ts → workflow.ts → storage.ts → index.ts` という循環になるが、型のみの import はコンパイル後に消えるため実行時の循環は生じない。

```ts
import type { Env } from './index';
import { parseWorkflow, type Workflow } from './schema';

const INLINE_LIMIT_BYTES = 512 * 1024;
const PREVIEW_LIMIT_CHARS = 4096;

export type StepOutput =
  | { kind: 'inline'; value: unknown }
  | { kind: 'r2'; key: string; bytes: number };

export class Storage {
  constructor(private readonly env: Env) {}

  async loadWorkflow(id: string): Promise<Workflow> {
    const row = await this.env.DB
      .prepare('SELECT definition FROM workflows WHERE id = ? AND enabled = 1')
      .bind(id)
      .first<{ definition: string }>();
    if (!row) throw new Error(`ワークフローが見つかりません: ${id}`);
    return parseWorkflow(JSON.parse(row.definition));
  }

  async listCronWorkflows(): Promise<Workflow[]> {
    const { results } = await this.env.DB
      .prepare('SELECT definition FROM workflows WHERE enabled = 1 AND cron IS NOT NULL')
      .all<{ definition: string }>();
    return results.map((r) => parseWorkflow(JSON.parse(r.definition)));
  }

  async startRun(runId: string, workflowId: string, triggerType: string, startedAt: string): Promise<void> {
    await this.env.DB.prepare(
      'INSERT INTO runs (id, workflow_id, status, trigger_type, started_at) VALUES (?,?,?,?,?)',
    ).bind(runId, workflowId, 'running', triggerType, startedAt).run();
  }

  async finishRun(
    runId: string,
    status: 'success' | 'failed',
    finishedAt: string,
    errorSummary?: string,
  ): Promise<void> {
    await this.env.DB.prepare(
      'UPDATE runs SET status = ?, finished_at = ?, error_summary = ? WHERE id = ?',
    ).bind(status, finishedAt, errorSummary ?? null, runId).run();
  }

  async recordStep(
    runId: string,
    node: { id: string; name: string },
    status: 'success' | 'failed' | 'skipped',
    info: { attempts: number; durationMs: number; output?: unknown; error?: string },
  ): Promise<void> {
    // D1 は行 2MB 上限があり、スキャン行数で課金される。preview は必ず切り詰める。
    const preview = info.output === undefined
      ? null
      : JSON.stringify(info.output).slice(0, PREVIEW_LIMIT_CHARS);
    await this.env.DB.prepare(
      `INSERT INTO run_steps (run_id, node_id, node_name, status, attempts, duration_ms, output_preview, error)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (run_id, node_id) DO UPDATE SET
         status = excluded.status, attempts = excluded.attempts,
         duration_ms = excluded.duration_ms, output_preview = excluded.output_preview,
         error = excluded.error`,
    ).bind(runId, node.id, node.name, status, info.attempts, info.durationMs, preview, info.error ?? null).run();
  }

  // step.do() の戻り値は 1MiB 上限。余裕を見て 512KB で R2 に切り替える。
  async saveOutput(runId: string, nodeId: string, value: unknown): Promise<StepOutput> {
    const json = JSON.stringify(value ?? null);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes <= INLINE_LIMIT_BYTES) return { kind: 'inline', value };
    const key = `runs/${runId}/${nodeId}.json`;
    await this.env.BUCKET.put(key, json, { httpMetadata: { contentType: 'application/json' } });
    return { kind: 'r2', key, bytes };
  }

  async readOutput(out: StepOutput): Promise<unknown> {
    if (out.kind === 'inline') return out.value;
    const obj = await this.env.BUCKET.get(out.key);
    if (!obj) throw new Error(`R2 のオブジェクトが見つかりません: ${out.key}`);
    return JSON.parse(await obj.text());
  }
}
```

- [ ] **Step 6: テストを実行して成功を確認**

Run: `npx vitest run test/storage.test.ts`
Expected: 7 件すべて PASS

- [ ] **Step 7: コミット**

```bash
git add migrations src/storage.ts test/storage.test.ts
git commit -m "ストレージ層: D1 スキーマ、実行履歴の記録、R2 退避"
```

---

## Task 9: Workflows 統合

**Files:**
- Create: `src/workflow.ts`, `test/workflow.test.ts`
- Modify: `src/index.ts`（`EdgeflowWorkflow` を export）、`wrangler.jsonc`（`workflows` バインディング追加）

**Interfaces:**
- Consumes: すべての先行タスク
- Produces:
  - `type WorkflowParams = { workflowId: string; triggerType: 'cron' | 'manual' }`
  - `class EdgeflowWorkflow extends WorkflowEntrypoint<Env, WorkflowParams>`
  - `export async function executeWorkflow(deps: ExecuteDeps): Promise<void>` — `step` を注入できる形にし、テストから呼べるようにする

- [ ] **Step 1: wrangler.jsonc に Workflows バインディングを追加**

`d1_databases` の隣に追記する。

```jsonc
  "workflows": [
    { "binding": "EXECUTE", "name": "edgeflow", "class_name": "EdgeflowWorkflow" }
  ],
```

- [ ] **Step 2: 失敗するテストを書く**

`test/workflow.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeWorkflow } from '../src/workflow';
import { Storage } from '../src/storage';

// step.do() のテストダブル。retries/timeout は無視し、即座に実行する。
const fakeStep = () => {
  const names: string[] = [];
  return {
    names,
    async do<T>(name: string, _opts: unknown, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      return fn();
    },
  };
};

const definition = {
  schemaVersion: 1, id: 'wf-1', name: 'demo',
  trigger: { type: 'manual' },
  nodes: [
    { id: 'a', type: 'transform', name: 'Seed', params: { value: { n: 4 } } },
    { id: 'b', type: 'if', name: 'Check', params: { condition: { $expr: '{{ $json.n > 3 }}' } } },
    { id: 'c', type: 'transform', name: 'Big', params: { value: { $expr: '{{ $json.n * 10 }}' } } },
    { id: 'd', type: 'transform', name: 'Small', params: { value: 0 } },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c', branch: 'true' },
    { from: 'b', to: 'd', branch: 'false' },
  ],
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM run_steps');
  await env.DB.exec('DELETE FROM runs');
  await env.DB.exec('DELETE FROM workflows');
  await env.DB.prepare(
    'INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES (?,?,?,NULL,1,?)',
  ).bind('wf-1', 'demo', JSON.stringify(definition), '2026-07-30T00:00:00Z').run();
});

describe('executeWorkflow', () => {
  it('分岐を通って成功し、履歴が残る', async () => {
    const step = fakeStep();
    await executeWorkflow({
      env, step: step as any, runId: 'run-1',
      workflowId: 'wf-1', triggerType: 'manual',
      nowIso: '2026-07-30T00:00:00.000Z',
    });

    expect(step.names).toEqual(['Seed', 'Check', 'Big']);

    const run = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind('run-1').first();
    expect(run?.status).toBe('success');

    const { results } = await env.DB.prepare(
      'SELECT node_id, status FROM run_steps WHERE run_id = ? ORDER BY node_id',
    ).bind('run-1').all<{ node_id: string; status: string }>();
    expect(results).toEqual([
      { node_id: 'a', status: 'success' },
      { node_id: 'b', status: 'success' },
      { node_id: 'c', status: 'success' },
      { node_id: 'd', status: 'skipped' },
    ]);
  });

  it('ノードが失敗したら run を failed にする', async () => {
    const broken = structuredClone(definition);
    broken.nodes[2]!.params = { value: { $expr: '{{ $json.missing.deep }}' } };
    await env.DB.prepare('UPDATE workflows SET definition = ? WHERE id = ?')
      .bind(JSON.stringify(broken), 'wf-1').run();

    const step = fakeStep();
    await expect(executeWorkflow({
      env, step: step as any, runId: 'run-2',
      workflowId: 'wf-1', triggerType: 'manual',
      nowIso: '2026-07-30T00:00:00.000Z',
    })).rejects.toThrow();

    const run = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind('run-2').first();
    expect(run?.status).toBe('failed');
  });

  it('$nodes で前のノードの出力を参照できる', async () => {
    const wf = structuredClone(definition);
    wf.nodes[2]!.params = { value: { $expr: "{{ $nodes['Seed'].n + 1 }}" } };
    await env.DB.prepare('UPDATE workflows SET definition = ? WHERE id = ?')
      .bind(JSON.stringify(wf), 'wf-1').run();

    await executeWorkflow({
      env, step: fakeStep() as any, runId: 'run-3',
      workflowId: 'wf-1', triggerType: 'manual',
      nowIso: '2026-07-30T00:00:00.000Z',
    });

    const row = await env.DB.prepare(
      'SELECT output_preview FROM run_steps WHERE run_id = ? AND node_id = ?',
    ).bind('run-3', 'c').first<{ output_preview: string }>();
    expect(JSON.parse(row!.output_preview)).toBe(5);
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認**

Run: `npx vitest run test/workflow.test.ts`
Expected: FAIL

- [ ] **Step 4: workflow.ts を実装**

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError as CfNonRetryableError } from 'cloudflare:workflows';
import { NonRetryableError } from './errors';
import { ExpressionEvaluator, type ExpressionScope } from './expression';
import { ExecutionPlanner } from './graph';
import { NODE_IMPLS } from './nodes';
import type { ParamValue, Workflow, WorkflowNode } from './schema';
import { Storage } from './storage';
import type { Env } from './index';

export type WorkflowParams = { workflowId: string; triggerType: 'cron' | 'manual' };

export type ExecuteDeps = {
  env: Env;
  step: Pick<WorkflowStep, 'do'>;
  runId: string;
  workflowId: string;
  triggerType: 'cron' | 'manual';
  nowIso: string;
};

export class EdgeflowWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    await executeWorkflow({
      env: this.env,
      step,
      runId: event.instanceId,
      workflowId: event.payload.workflowId,
      triggerType: event.payload.triggerType,
      // $now は実行開始時に 1 度だけ確定させ全ノードに配る。
      // Workers のタイマーは最後の I/O 時点で止まるため、ノードごとに取ると値が揺れる。
      nowIso: new Date(event.timestamp).toISOString(),
    });
  }
}

export async function executeWorkflow(deps: ExecuteDeps): Promise<void> {
  const { env, step, runId, workflowId, triggerType, nowIso } = deps;
  const storage = new Storage(env);
  const wf = await storage.loadWorkflow(workflowId);

  await storage.startRun(runId, workflowId, triggerType, nowIso);

  const evaluator = new ExpressionEvaluator();
  const planner = new ExecutionPlanner(wf);
  const outputs: Record<string, unknown> = {};
  let lastOutput: unknown = null;

  try {
    let node = planner.next();
    while (node !== null) {
      const current = node;
      const startedAt = Date.now();

      const result = await step.do(
        current.name,
        {
          retries: {
            limit: current.retry?.limit ?? wf.defaultRetryLimit ?? 3,
            delay: 10_000,
            backoff: 'exponential',
          },
          timeout: '2 minutes',
        },
        async () => runNode(wf, current, evaluator, {
          $json: lastOutput,
          $nodes: outputs,
          $secrets: secretsOf(env),
          $now: { iso: nowIso, date: new Date(nowIso) },
          $run: { id: runId, workflowName: wf.name, attempt: 1 },
        }),
      );

      const saved = await storage.saveOutput(runId, current.id, result.output);
      await storage.recordStep(runId, current, 'success', {
        attempts: 1,
        durationMs: Date.now() - startedAt,
        output: result.output,
      });

      outputs[current.name] = result.output;
      lastOutput = await storage.readOutput(saved);
      planner.complete(current.id, { branch: result.branch });
      node = planner.next();
    }

    for (const id of planner.skipped()) {
      const n = wf.nodes.find((x) => x.id === id)!;
      await storage.recordStep(runId, n, 'skipped', { attempts: 0, durationMs: 0 });
    }

    await storage.finishRun(runId, 'success', new Date().toISOString());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await storage.finishRun(runId, 'failed', new Date().toISOString(), message.slice(0, 500));
    throw e;
  }
}

async function runNode(
  wf: Workflow,
  node: WorkflowNode,
  evaluator: ExpressionEvaluator,
  scope: ExpressionScope,
) {
  let params: Record<string, unknown>;
  try {
    params = resolveParams(node.params, evaluator, scope);
  } catch (e) {
    // 式のエラーはリトライしても直らない。
    throw new CfNonRetryableError(e instanceof Error ? e.message : String(e));
  }

  try {
    return await NODE_IMPLS[node.type]({
      params,
      input: scope.$json,
      run: { id: scope.$run.id, workflowName: wf.name, attempt: scope.$run.attempt, now: scope.$now },
    });
  } catch (e) {
    if (e instanceof NonRetryableError) throw new CfNonRetryableError(e.message);
    throw e;
  }
}

// 式は必ずノード呼び出しの前に解決する。ノード実装は $expr の存在を知らない。
function resolveParams(
  params: Record<string, ParamValue>,
  evaluator: ExpressionEvaluator,
  scope: ExpressionScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = isExpr(value) ? evaluator.evaluate(value.$expr, scope) : value;
  }
  return out;
}

function isExpr(v: ParamValue): v is { $expr: string } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && '$expr' in v;
}

// Wrangler Secrets は env に文字列として現れる。バインディング（DB / BUCKET / EXECUTE）は除く。
function secretsOf(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
```

- [ ] **Step 5: src/index.ts で Workflow を export し Env を拡張**

```ts
import type { WorkflowParams } from './workflow';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EXECUTE: Workflow<WorkflowParams>;
  [key: string]: unknown;
}

export { EdgeflowWorkflow } from './workflow';

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: テストを実行して成功を確認**

Run: `npx vitest run test/workflow.test.ts`
Expected: 3 件すべて PASS

`cloudflare:workflows` が vitest 環境で解決できない場合は、`NonRetryableError` の import を `src/errors.ts` 側に寄せ、`workflow.ts` では動的に扱う。その場合もテストの期待値は変えない。

- [ ] **Step 7: コミット**

```bash
git add src/workflow.ts src/index.ts wrangler.jsonc test/workflow.test.ts
git commit -m "Workflows 統合: ノードを step.do に写像しリトライ可否を判定"
```

---

## Task 10: cron トリガーと手動実行

**Files:**
- Modify: `src/index.ts`, `wrangler.jsonc`
- Create: `test/triggers.test.ts`

**Interfaces:**
- Consumes: `Storage`（Task 8）、`EdgeflowWorkflow`（Task 9）
- Produces: `POST /runs` エンドポイント、`scheduled` ハンドラ

- [ ] **Step 1: wrangler.jsonc に cron を追加**

```jsonc
  "triggers": { "crons": ["*/15 * * * *"] },
```

15 分ごとに起き、D1 の `cron` 列と現在時刻を突き合わせて対象を選ぶ。**Cron Trigger の式と D1 の定義を一致させる運用が必要**な点は仕様の §9 に記録済み。

- [ ] **Step 2: 失敗するテストを書く**

`test/triggers.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const definition = {
  schemaVersion: 1, id: 'wf-1', name: 'demo',
  trigger: { type: 'manual' },
  nodes: [{ id: 'a', type: 'transform', name: 'A', params: { value: 1 } }],
  edges: [],
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM run_steps');
  await env.DB.exec('DELETE FROM runs');
  await env.DB.exec('DELETE FROM workflows');
  await env.DB.prepare(
    'INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES (?,?,?,NULL,1,?)',
  ).bind('wf-1', 'demo', JSON.stringify(definition), '2026-07-30T00:00:00Z').run();
});

describe('POST /runs', () => {
  it('runId を返す', async () => {
    const res = await SELF.fetch('http://x.test/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json<{ runId: string }>();
    expect(body.runId).toBeTruthy();
  });

  it('存在しない workflowId は 404', async () => {
    const res = await SELF.fetch('http://x.test/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: 'zzz' }),
    });
    expect(res.status).toBe(404);
  });

  it('workflowId が無ければ 400', async () => {
    const res = await SELF.fetch('http://x.test/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認**

Run: `npx vitest run test/triggers.test.ts`
Expected: FAIL（404 が返る）

- [ ] **Step 4: src/index.ts を実装**

```ts
import { Storage } from './storage';
import type { WorkflowParams } from './workflow';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EXECUTE: Workflow<WorkflowParams>;
  [key: string]: unknown;
}

export { EdgeflowWorkflow } from './workflow';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') return Response.json({ ok: true });

    if (url.pathname === '/runs' && request.method === 'POST') {
      const body = await request.json<{ workflowId?: string }>().catch(() => ({}));
      if (!body.workflowId) {
        return Response.json({ error: 'workflowId が必要です' }, { status: 400 });
      }
      try {
        await new Storage(env).loadWorkflow(body.workflowId);
      } catch {
        return Response.json({ error: 'ワークフローが見つかりません' }, { status: 404 });
      }
      const instance = await env.EXECUTE.create({
        params: { workflowId: body.workflowId, triggerType: 'manual' },
      });
      return Response.json({ runId: instance.id }, { status: 202 });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(startDueWorkflows(env));
  },
} satisfies ExportedHandler<Env>;

async function startDueWorkflows(env: Env): Promise<void> {
  const workflows = await new Storage(env).listCronWorkflows();
  for (const wf of workflows) {
    await env.EXECUTE.create({ params: { workflowId: wf.id, triggerType: 'cron' } });
  }
}
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npx vitest run test/triggers.test.ts`
Expected: 3 件すべて PASS

`env.EXECUTE.create` が vitest 環境で使えない場合、テストは `POST /runs` の 400 / 404 のみを検証し、202 のケースは Task 11 の実デプロイ確認に回す。その旨をテストにコメントで残す。

- [ ] **Step 6: コミット**

```bash
git add src/index.ts wrangler.jsonc test/triggers.test.ts
git commit -m "cron トリガーと手動実行エンドポイント"
```

---

## Task 11: エンドツーエンド確認とデプロイ

**Files:**
- Create: `fixtures/daily-report.json`, `test/e2e.test.ts`, `docs/USAGE.md`

**Interfaces:**
- Consumes: すべて
- Produces: 実際に動くワークフロー定義の例と、デプロイ手順

- [ ] **Step 1: 実用的なワークフロー定義を書く**

`fixtures/daily-report.json`:

```json
{
  "schemaVersion": 1,
  "id": "daily-report",
  "name": "daily-report",
  "trigger": { "type": "cron", "cron": "0 9 * * *" },
  "nodes": [
    {
      "id": "fetch",
      "type": "http",
      "name": "Fetch",
      "params": { "url": "https://api.github.com/repos/cloudflare/workerd", "headers": { "user-agent": "edgeflow" } }
    },
    {
      "id": "check",
      "type": "if",
      "name": "HasStars",
      "params": { "condition": { "$expr": "{{ $json.body.stargazers_count > 0 }}" } }
    },
    {
      "id": "compose",
      "type": "transform",
      "name": "Compose",
      "params": { "value": { "$expr": "workerd は {{ $nodes['Fetch'].body.stargazers_count }} スターです（{{ $now.iso }}）" } }
    },
    {
      "id": "post",
      "type": "notify",
      "name": "Post",
      "params": { "webhookUrl": { "$expr": "{{ $secrets.SLACK_WEBHOOK_URL }}" }, "text": { "$expr": "{{ $json }}" } }
    }
  ],
  "edges": [
    { "from": "fetch", "to": "check" },
    { "from": "check", "to": "compose", "branch": "true" },
    { "from": "compose", "to": "post" }
  ]
}
```

- [ ] **Step 2: ゴールデンテストを書く**

`test/e2e.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { executeWorkflow } from '../src/workflow';
import definition from '../fixtures/daily-report.json';

const fakeStep = () => {
  const names: string[] = [];
  return {
    names,
    async do<T>(name: string, _o: unknown, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      return fn();
    },
  };
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM run_steps');
  await env.DB.exec('DELETE FROM runs');
  await env.DB.exec('DELETE FROM workflows');
  await env.DB.prepare(
    'INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES (?,?,?,?,1,?)',
  ).bind('daily-report', 'daily-report', JSON.stringify(definition), '0 9 * * *', '2026-07-30T00:00:00Z').run();

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('api.github.com')) {
      return new Response(JSON.stringify({ stargazers_count: 6000 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('daily-report ワークフロー', () => {
  it('4 ノードを通って成功する', async () => {
    const step = fakeStep();
    await executeWorkflow({
      env, step: step as any, runId: 'e2e-1',
      workflowId: 'daily-report', triggerType: 'cron',
      nowIso: '2026-07-30T09:00:00.000Z',
    });

    expect(step.names).toEqual(['Fetch', 'HasStars', 'Compose', 'Post']);

    const run = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind('e2e-1').first();
    expect(run?.status).toBe('success');

    const compose = await env.DB.prepare(
      'SELECT output_preview FROM run_steps WHERE run_id = ? AND node_id = ?',
    ).bind('e2e-1', 'compose').first<{ output_preview: string }>();
    expect(JSON.parse(compose!.output_preview))
      .toBe('workerd は 6000 スターです（2026-07-30T09:00:00.000Z）');
  });
});
```

`fixtures/daily-report.json` を import するため `tsconfig.json` の `compilerOptions` に `"resolveJsonModule": true` を追加する。

- [ ] **Step 3: テストを実行して成功を確認**

Run: `npx vitest run test/e2e.test.ts`
Expected: PASS

- [ ] **Step 4: 全テストと型チェック**

Run: `npm test && npm run typecheck`
Expected: すべて PASS

- [ ] **Step 5: バンドルサイズと startup を計測**

Run: `npm run size && npm run startup`

gzip 値と startup ms を記録表に追記する。**gzip が 10 MB を超えるか startup が 1 秒に近づいていれば、ここで対策を検討する。**

- [ ] **Step 6: 本番の D1 にマイグレーションを適用しデプロイ**

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler deploy
```

`wrangler deploy` の出力する `Worker Startup Time` を記録表に追記する。**ローカル計測との差を確認する**（過去の実測では 5.5% 差だった）。

- [ ] **Step 7: 本番のワークフローを登録して手動実行**

```bash
npx wrangler d1 execute DB --remote --command \
  "INSERT INTO workflows (id, name, definition, cron, enabled, updated_at) VALUES ('daily-report','daily-report',readfile('fixtures/daily-report.json'),'0 9 * * *',1,datetime('now'))"
```

`readfile` が使えない場合は JSON をエスケープして直接埋め込む。

```bash
curl -X POST https://edgeflow.<subdomain>.workers.dev/runs \
  -H 'content-type: application/json' \
  -d '{"workflowId":"daily-report"}'
```

`runId` が返り、Slack に通知が届き、`runs` テーブルに `success` が入ることを確認する。

- [ ] **Step 8: USAGE.md を書く**

`docs/USAGE.md` に以下を記載する。

**ノードのパラメータ表**（必須／任意を明示）:

| type | 必須 | 任意 |
|---|---|---|
| `http` | `url` | `method`（既定 GET）、`headers`、`body` |
| `transform` | `value` | ー |
| `if` | `condition` | ー |
| `notify` | `webhookUrl`（https 必須）、`text` | ー |

**式変数の表**: `$json`（直前の出力）、`$nodes['名前']`（任意ノードの出力）、`$secrets.NAME`、`$now.iso` / `$now.date`、`$run.id` / `$run.workflowName`。`$json` は `http` ノードの後なら `{ status, headers, body }` の形である点を明記する。

**Secrets の登録**: `npx wrangler secret put SLACK_WEBHOOK_URL`

**定義の登録**: `npx wrangler d1 execute DB --remote --command "INSERT INTO workflows ..."` の実例を 1 本載せる。

**手動実行**: `curl -X POST .../runs -d '{"workflowId":"..."}'`

**履歴の確認**（そのまま貼れる SQL）:

```sql
SELECT id, status, started_at, finished_at, error_summary
FROM runs WHERE workflow_id = 'daily-report' ORDER BY started_at DESC LIMIT 10;

SELECT node_name, status, attempts, duration_ms, substr(output_preview, 1, 120) AS preview, error
FROM run_steps WHERE run_id = '<RUN_ID>';
```

**制約の注意書き**: 生 TCP を要するノード（Postgres 等）は Workers の制約により実装不可能であること、`step.do()` の戻り値 1 MiB 上限のため大きな出力は自動で R2 に退避されること。

- [ ] **Step 9: コミット**

```bash
git add fixtures test/e2e.test.ts docs/USAGE.md tsconfig.json
git commit -m "エンドツーエンド確認と利用手順"
```

---

## 計測記録

各タスクの最後に追記する。

| タスク | gzip サイズ | startup（ローカル） | startup（本番） |
|---|---|---|---|
| Task 1 | | | ー |
| Task 3 | | ー | ー |
| Task 11 | | | |

**上限**: gzip 10 MB / startup 1,000 ms。参考値として、`n8n-workflow` を含む調査時点の実測は gzip 627.92 KiB / 本番 103 ms だった。本計画では `n8n-workflow` を外すため、これより小さくなる見込み。

---

## 完了条件

- `npm test` が全件 PASS する
- `npm run typecheck` がエラーなし
- 本番にデプロイでき、`Worker Startup Time` が 1,000 ms を大きく下回る
- `POST /runs` で `fixtures/daily-report.json` が実行され、Slack に通知が届く
- `runs` と `run_steps` に履歴が残り、スキップされたノードが `skipped` として記録されている

## 積み残し（次のサブプロジェクトへ）

- ワークフロー定義の REST API（現状は D1 に直接 INSERT）
- ビジュアルエディタ
- 認証（現状は Cloudflare Access で保護する前提）
- `wrangler.jsonc` の cron 式と D1 の `cron` 列の二重管理の解消
- 実行履歴のプルーニング
- 式拡張関数（`.toSnakeCase()` 等）の要否判断
- **429 の `Retry-After` を尊重したリトライ間隔。** 仕様 §7 に記載があるが、Workflows の `retries.delay` に関数を渡せるかが未確認（仕様 §12-3）のため本計画では実装しない。429 は固定の指数バックオフでリトライする
