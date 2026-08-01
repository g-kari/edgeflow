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
