import { requireParam, type NodeImpl } from './types';

// 条件を真偽で判定し、入力はそのまま下流へ透過する。
export const ifNode: NodeImpl = async (ctx) => {
  const condition = requireParam(ctx, 'condition');
  return { output: ctx.input, branch: condition ? 'true' : 'false' };
};
