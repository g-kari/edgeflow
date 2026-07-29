// Node（= Cloudflare Container 内相当）から Neon へ到達できるかの検証。
// 存在しないエンドポイント名 + でたらめな認証情報を使い、返るエラーの「種類」で
// ネットワーク到達性を判定する。DNS エラーでも接続拒否でもなく Postgres の
// 認証エラーが返れば、443 で Neon の実インフラまで届いている証拠になる。
const { Pool, neon, neonConfig } = require('@neondatabase/serverless');
const DSN = 'postgresql://u:p@ep-nonexistent-test.ap-southeast-1.aws.neon.tech/db?sslmode=require';

(async () => {
  console.log('Node:', process.version, '| global WebSocket:', typeof WebSocket);
  console.log('neonConfig.webSocketConstructor (未設定時):', typeof neonConfig.webSocketConstructor);

  // (A) 何も注入せず WebSocket モード
  try { await new Pool({ connectionString: DSN }).query('select 1'); }
  catch (e) { console.log('(A) 素の Pool        →', e.constructor.name, '|', e.message); }

  // (B) global WebSocket を明示注入
  try {
    neonConfig.webSocketConstructor = WebSocket;
    await new Pool({ connectionString: DSN }).query('select 1');
  } catch (e) { console.log('(B) WebSocket 注入   →', e.constructor.name, '|', e.message); }

  // (C) HTTP モード
  try { await neon(DSN)`select 1`; }
  catch (e) { console.log('(C) HTTP(neon タグ)  →', e.constructor.name, '|', e.message); }

  process.exit(0);
})();
