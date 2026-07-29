import { Expression } from 'n8n-workflow';
export default {
  async fetch(req, env) {
    const r = { hasBinding: !!env.UNSAFE_EVAL };
    try {
      // Patch globalThis.Function with the unsafe-eval binding's newFunction
      const orig = globalThis.Function;
      const ue = env.UNSAFE_EVAL;
      r.bindingKeys = ue ? Object.getOwnPropertyNames(Object.getPrototypeOf(ue)) : null;
      globalThis.Function = function (...args) {
        const body = args.pop();
        return ue.newFunction(`(function(${args.join(',')}){${body}})`, 'n8n-expr');
      };
      globalThis.Function.prototype = orig.prototype;
      r.math = Expression.resolveWithoutWorkflow('={{ 1 + 2 }}');
      r.ext  = Expression.resolveWithoutWorkflow('={{ "hello world".toSnakeCase() }}');
      r.date = Expression.resolveWithoutWorkflow('={{ $now.year }}');
    } catch (e) { r.error = String(e && e.message || e); r.stack=String(e&&e.stack||'').split('\n').slice(0,4); }
    return new Response(JSON.stringify(r, null, 1));
  }
};
