import * as esbuild from 'esbuild';
import { stubPlugin } from './stub.mjs';
const NODE_BUILTINS = ['path','events','fs','os','crypto','stream','util','buffer','url','assert','zlib','string_decoder','timers','process','net','tls','http','https','querystring','punycode','fs/promises','async_hooks','worker_threads','vm','child_process'];
const r = await esbuild.build({
  entryPoints:['entry.js'], bundle:true, format:'esm',
  platform:'browser', conditions:['workerd','worker','browser','import'],
  external:[...NODE_BUILTINS, ...NODE_BUILTINS.map(m=>'node:'+m)],
  plugins:[stubPlugin], outfile:'out.js', metafile:true, logLevel:'warning',
});
console.log('BUILD OK');
