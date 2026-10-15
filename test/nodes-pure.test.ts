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
