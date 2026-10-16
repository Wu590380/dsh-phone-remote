// 探测 dsh 0.2.x 的实时通道（WS）到底在哪个路径、需要什么头
const http = require('http');
const { execFileSync } = require('child_process');

const PORT = parseInt(process.argv[2] || '19387', 10);
const COOKIE = process.argv[3] || '';
const AUTHORITY = '127.0.0.1:' + PORT;

const PATHS = [
  '/api/events/mux', '/api/events/host', '/api/events.mux', '/api/events.host',
  '/api/events', '/api/mux', '/api/ws', '/api/event-stream',
  '/api/session/events', '/api/stream', '/api/live', '/api/rpc/events',
];

const extra = process.argv.includes('--origin') ? {
  Origin: 'http://' + AUTHORITY,
  Referer: 'http://' + AUTHORITY + '/',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
} : {};

function probe(path) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: Object.assign({
        Host: AUTHORITY,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.from('the sample nonce').toString('base64'),
        'Sec-WebSocket-Version': '13',
      }, COOKIE ? { Cookie: COOKIE } : {}, extra),
    }, (res) => { res.resume(); resolve({ path, status: res.statusCode, upgraded: false }); });
    req.on('upgrade', (res, socket) => { try { socket.destroy(); } catch (_) {} resolve({ path, status: 101, upgraded: true }); });
    req.on('error', (e) => resolve({ path, status: 0, err: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ path, status: 0, err: 'timeout' }); });
    req.end();
  });
}

(async () => {
  console.log(`目标 127.0.0.1:${PORT}  带头部: ${process.argv.includes('--origin') ? '有 Origin/UA' : '无 Origin'}`);
  for (const p of PATHS) {
    const r = await probe(p);
    const tag = r.upgraded ? '✅ 101 升级成功' : (r.status ? `HTTP ${r.status}` : `× ${r.err}`);
    console.log(`  ${p.padEnd(24)} ${tag}`);
  }
})();
