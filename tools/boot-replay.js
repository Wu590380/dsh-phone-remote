// 复现浏览器的 boot 序列：从 __DSH_BOOT__ 里取出全部资源，逐个拉，报状态/大小/耗时
const http = require('http');

const PORT = parseInt(process.argv[2] || '19391', 10);
const COOKIE = process.argv[3] || '';
const HOSTHDR = process.argv[4] || '127.0.0.1:19391';

function get(path, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { Host: HOSTHDR, Cookie: COOKIE, 'Accept-Encoding': 'identity' } }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ path, status: res.statusCode, ct: String(res.headers['content-type'] || '').slice(0, 30), size: Buffer.concat(chunks).length, ms: Date.now() - t0 }));
    });
    req.on('error', e => resolve({ path, status: 0, err: e.message, ms: Date.now() - t0 }));
    req.setTimeout(timeoutMs || 12000, () => { req.destroy(); resolve({ path, status: 0, err: 'TIMEOUT ' + (timeoutMs || 12000) + 'ms', ms: Date.now() - t0 }); });
    req.end();
  });
}

(async () => {
  const home = await get('/');
  console.log('首页:', home.status, home.size + 'B', home.ms + 'ms');
  if (home.status !== 200) return;
  const body = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/', headers: { Host: HOSTHDR, Cookie: COOKIE } }, (res) => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => resolve(s));
    });
  });
  // 抓出 boot 清单里所有 url（相对路径补齐开头的 /）
  const urls = [...new Set([...body.matchAll(/"url":"([^"]+)"/g)].map(m => m[1]))]
    .map(u => u.startsWith('/') ? u : './' + u)
    .map(u => u.replace(/^\.\//, '/'));
  console.log('boot 清单资源数:', urls.length);
  let bad = 0;
  for (const u of urls) {
    const r = await get(u, 10000);
    const flag = r.status === 200 ? 'ok ' : '❌ ';
    if (r.status !== 200) bad++;
    console.log(`  ${flag}${String(r.status).padEnd(4)} ${String(r.size).padEnd(8)}B ${String(r.ms).padEnd(6)}ms ${r.ct.padEnd(22)} ${u.slice(0, 90)}`);
  }
  console.log(bad ? `\n共 ${bad} 个资源没拿到 200` : '\n全部资源都正常');
})();
