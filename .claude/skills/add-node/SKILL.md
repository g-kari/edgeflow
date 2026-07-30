---
name: add-node
description: edgeflow に新しいノード型を追加する。「ノードを追加」「ノード型を作る」「HTTP ノードのようなものを足したい」「Slack ノードが欲しい」などと言われたときに使う。スキーマの型追加からノード実装、レジストリ登録、テスト、ドキュメント更新までの手順と、踏みやすい落とし穴をまとめてある。
---

# ノード型を追加する

edgeflow のノードは**単なる非同期関数**です。式の解決は呼び出し側で済んでいるため、ノード実装は `$expr` の存在を知りません。

```ts
type NodeImpl = (ctx: NodeContext) => Promise<NodeResult>;
```

## 追加前に決めること

**そのノードは Workers で実装可能か。** 生 TCP を要するもの（Postgres、MySQL、Redis、MQTT、Kafka）、ネイティブライブラリを要するもの、ファイルシステムを前提にするものは**恒久的に不可能**です。HTTP で叩けるサービスなら可能です。

**既存ノードのラッパで足りないか。** `notify` は実質 `http` のラッパですが、パラメータ検証ができ UI で別物として見えるという理由で分けています。その理由が無いなら足さないでください（YAGNI）。

## 手順

### 1. スキーマに型を足す

`src/schema.ts`:

```ts
export const NODE_TYPES = ['http', 'transform', 'if', 'notify', 'あなたの型'] as const;
```

`NodeType` は `NODE_TYPES` から導出されるので、これだけで型が通ります。

### 2. 失敗するテストを先に書く

ノードは 2 種類に分かれ、テストの置き場所が違います。

**`fetch` を使わないノード** → `test/nodes-pure.test.ts` に追記

```ts
describe('あなたの型 ノード', () => {
  it('期待する出力を返す', async () => {
    const r = await NODE_IMPLS['あなたの型'](ctx({ someParam: 'value' }));
    expect(r.output).toBe(/* 期待値 */);
  });

  it('必須パラメータが無ければ NonRetryableError', async () => {
    await expect(NODE_IMPLS['あなたの型'](ctx({}))).rejects.toThrow(NonRetryableError);
  });
});
```

**`fetch` を使うノード** → `test/nodes-fetch.test.ts` に追記。`vi.stubGlobal('fetch', ...)` で差し替えます。**5xx と 429 はリトライ可能、それ以外の 4xx は `NonRetryableError` になることを必ずテストしてください。** ここは間違えやすく、間違えると 401 を 5 回投げて 50 秒待つことになります。

### 3. 実装する

`src/nodes/あなたの型.ts`:

```ts
import { isRetryableStatus, NonRetryableError } from '../errors';
import { requireParam, type NodeImpl } from './types';

export const あなたの型Node: NodeImpl = async (ctx) => {
  const required = String(requireParam(ctx, 'someParam'));
  // ctx.params は解決済み。ctx.input が $json。
  return { output: /* 結果 */ };
};
```

`fetch` を使う場合、エラー処理はこの形にします。

```ts
if (!res.ok) {
  const message = `HTTP ${res.status}`;
  if (!isRetryableStatus(res.status)) throw new NonRetryableError(message);
  throw new Error(message);
}
```

### 4. レジストリに登録する

`src/nodes/index.ts` の `NODE_IMPLS` に足します。`Record<NodeType, NodeImpl>` なので、登録し忘れると型エラーになります。

### 5. 検証して計測する

```bash
npm test && npm run typecheck && npm run size
```

依存を足した場合は `npm run startup` も実行し、1,000 ms を大きく下回っていることを確認します。

### 6. ドキュメントを更新する

`docs/USAGE.md` のパラメータ表に追記します。必須と任意を明示してください。

### 7. コミットする

日本語のメッセージで。例: `Slack ノードを追加`

## 落とし穴

**分岐を返せるのは `if` だけです。** `NodeResult.branch` を他のノードが返しても、`graph.ts` は `if` 以外では無視します。分岐が必要なら `if` を使う設計にしてください。

**大きな出力を気にしなくてよい。** `step.do()` の 1 MiB 上限は `storage.ts` が 512 KB 超で R2 に退避して吸収します。ノード側で意識する必要はありません。

**並列 `fetch` を増やさない。** Workers の同時アウトバウンド接続は **6** です。1 ノード内で多数の並列リクエストを投げると詰まります。

**`$now` を自分で取らない。** `ctx.run.now` を使ってください。Workers のタイマーは「最後の I/O 時点」で止まるため、ノード内で `Date.now()` を呼ぶと意味のない値になります。

**依存を足す前に `CLAUDE.md` を読む。** 実行時依存は 3 つだけに保っています。npm パッケージが必要に見えても、Workers で動かない（ネイティブ依存、生 TCP）ことが多いです。
