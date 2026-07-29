// Worker Loader が受け取れるモジュールサイズの上限を探る。
// 実行エンジン(n8n-workflow ≒ raw 3.1MB)を動的 Worker 内に入れられるかを決める。
function makeModule(targetBytes) {
  // 実コードに近い形で嵩を作る（単なる文字列リテラルだと最適化される可能性があるため関数を並べる）
  const chunks = [];
  let size = 0, i = 0;
  while (size < targetBytes) {
    const fn = `export function pad${i}(a,b){ /* ${'x'.repeat(180)} */ return a+b+${i}; }\n`;
    chunks.push(fn); size += fn.length; i++;
  }
  chunks.push(`export default { async fetch(){ return new Response(String(pad0(1,2))); } };\n`);
  return chunks.join('');
}

const SIZES = [
  ['512KB',  512 * 1024],
  ['1MB',   1024 * 1024],
  ['3MB',   3 * 1024 * 1024],
  ['5MB',   5 * 1024 * 1024],
  ['10MB', 10 * 1024 * 1024],
  ['20MB', 20 * 1024 * 1024],
];

export default {
  async fetch(req, env) {
    const out = { hasLoader: !!env.LOADER, results: {} };
    for (const [label, bytes] of SIZES) {
      const source = makeModule(bytes);
      try {
        const w = await env.LOADER.get(`size-${label}`, async () => ({
          compatibilityDate: '2025-09-15',
          mainModule: 'main.js',
          modules: { 'main.js': source },
          globalOutbound: null,
        }));
        const resp = await w.getEntrypoint().fetch('http://x/');
        const body = await resp.text();
        out.results[label] = { actualBytes: source.length, ok: resp.ok, body: body.slice(0, 20) };
      } catch (e) {
        out.results[label] = { actualBytes: source.length, ok: false, error: String(e && e.message || e).slice(0, 200) };
      }
    }
    return new Response(JSON.stringify(out, null, 1));
  }
};
