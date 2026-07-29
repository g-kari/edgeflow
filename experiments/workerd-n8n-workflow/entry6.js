export default {
  async fetch(req, env) {
    const r = { hasLoader: !!env.LOADER };
    try {
      const w = await env.LOADER.get('expr-1', async () => ({
        compatibilityDate: '2025-09-01',
        mainModule: 'main.js',
        modules: { 'main.js': `export default { async fetch(){ const f = (a,b)=>a+b; return new Response(String(f(1,2))); } }` },
        globalOutbound: null,
      }));
      const resp = await w.getEntrypoint().fetch('http://x/');
      r.dynamicResult = await resp.text();
    } catch (e) { r.error = String(e && e.message || e); }
    return new Response(JSON.stringify(r, null, 1));
  }
};
