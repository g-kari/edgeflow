import { requireParam, type NodeImpl } from './types';

// 式 1 本を評価して返すだけ。評価そのものは呼び出し側で済んでいる。
export const transformNode: NodeImpl = async (ctx) => {
  return { output: requireParam(ctx, 'value') };
};
