import { Expression } from 'n8n-workflow';
export default {
  async fetch() {
    const r = {};
    try {
      r.engine = Expression.getActiveImplementation();
      r.math = Expression.resolveWithoutWorkflow('={{ 1 + 2 }}');
      r.str  = Expression.resolveWithoutWorkflow('={{ "ab".toUpperCase() }}');
      r.ext  = Expression.resolveWithoutWorkflow('={{ "hello world".toSnakeCase() }}');
      r.date = Expression.resolveWithoutWorkflow('={{ $now.year }}');
      r.data = Expression.resolveWithoutWorkflow('={{ $json.foo }}', { $json: { foo: 'bar' } });
    } catch (e) { r.error = String(e && e.message || e); r.stack = String(e&&e.stack||'').split('\n').slice(0,5); }
    return new Response(JSON.stringify(r, null, 1));
  }
};
