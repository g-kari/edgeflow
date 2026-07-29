// 内側エンジン。wrangler のバンドル出力形式（ESM/IIFE）に依存しないよう
// globalThis 経由で公開する。
import { Workflow } from 'n8n-workflow';

let TABLE = {};

globalThis.__CFN8N__ = {
  Workflow,
  registerExpressionTable(t) { TABLE = t; },
  // 式評価はモジュールに焼き込まれたテーブルを引くだけ。eval も new Function も不要。
  evaluateExpression(expr, data) {
    const fn = TABLE[expr];
    if (!fn) throw new Error('expression not compiled: ' + expr);
    const errors = [];
    const value = fn.call(data, (e) => errors.push(String(e && e.message || e)));
    return { value, errors };
  },
};

export default { async fetch() { return new Response('engine'); } };
