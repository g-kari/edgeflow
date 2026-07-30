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

  it('複数チャンクのエラーを全件メッセージに残し cause で元の Error を保持する', () => {
    const ev = new ExpressionEvaluator();
    try {
      ev.evaluate('{{ $json.a.b }} と {{ $json.c.d }}', scope());
      throw new Error('例外が投げられなかった');
    } catch (e) {
      const err = e as Error & { cause?: unknown };
      // 2 件とも message に現れる
      expect(err.message.split(' / ').length).toBeGreaterThanOrEqual(2);
      // 元の Error が cause で辿れる
      expect(err.cause).toBeInstanceOf(Error);
    }
  });
});
