// 验证 pc.example.com 的 WebSocket 升级能否穿透隧道（dsh 网页 UI 靠它做实时流）
const https = require('https');
const fs = require('fs');
const path = require('path');

const HOST = process.argv[2] || 'pc.example.com';
const IP = process.argv[3] || '172.67.132.213';
const WSPATH = process.argv[4] || '/api/events.mux';
const TOKEN = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'dsh-web-token.txt'), 'utf8').trim(); } catch (_) { return ''; } })();

function tryUpgrade(label, headers, cb) {
  const req = https.request({
    host: IP, port: 443, path: WSPATH, method: 'GET', servername: HOST,
    headers: Object.assign({
      Host: HOST,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': Buffer.from('the sample nonce').toString('base64'),
      'Sec-WebSocket-Version': '13',
      'User-Agent': 'mc-ws-test',
    }, headers),
  }, (res) => {
    console.log(`  ${label}: HTTP ${res.statusCode}（未升级）`);
    res.resume(); cb(false);
  });
  req.on('upgrade', (res, socket) => {
    console.log(`  ${label}: ✅ 101 Switching Protocols`);
    try { socket.destroy(); } catch (_) {}
    cb(true);
  });
  req.on('error', (e) => { console.log(`  ${label}: 错误 ${e.message}`); cb(false); });
  req.setTimeout(20000, () => { console.log(`  ${label}: 超时`); req.destroy(); cb(false); });
  req.end();
}

console.log('目标:', HOST, '->', IP, ' 令牌:', TOKEN ? TOKEN.slice(0, 8) + '…' : '(缺)');
tryUpgrade('无令牌（应被拒）', {}, (a) => {
  tryUpgrade('带正确 cookie（应 101）', { Cookie: 'mc_dsh=' + TOKEN }, (b) => {
    console.log(b ? '\n✅ WebSocket 穿透正常，网页实时功能可用' : '\n❌ WebSocket 没穿透（UI 实时流会不可用）');
  });
});
