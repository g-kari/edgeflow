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
