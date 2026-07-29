import { Pool, Client, neon, neonConfig } from '@neondatabase/serverless';
export default {
  async fetch() {
    const r = {};
    try {
      r.exports = { Pool: typeof Pool, Client: typeof Client, neon: typeof neon, neonConfig: typeof neonConfig };
      // Workers では WebSocket がグローバルに存在するため追加設定不要のはず
      r.globalWebSocket = typeof WebSocket;
      const pool = new Pool({ connectionString: 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db?sslmode=require' });
      r.poolConstructed = true;
      r.poolQueryType = typeof pool.query;
      const sql = neon('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db?sslmode=require');
      r.neonTaggedType = typeof sql;
      // cloudflare:sockets の connect が使えるか
      const sockets = await import('cloudflare:sockets');
      r.cfConnect = typeof sockets.connect;
    } catch (e) { r.error = String(e && e.message || e); r.stack = String(e&&e.stack||'').split('\n').slice(0,4); }
    return new Response(JSON.stringify(r, null, 1));
  }
};
