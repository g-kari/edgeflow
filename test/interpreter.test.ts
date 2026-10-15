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
