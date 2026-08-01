import { NonRetryableError } from '../errors';

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
