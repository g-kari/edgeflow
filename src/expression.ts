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
