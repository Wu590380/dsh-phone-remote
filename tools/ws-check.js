#!/usr/bin/env node
/* 对比 WebSocket 握手：直连分发服务 vs 经过面板转发。用法: node tools/ws-check.js <令牌> <主机> */
'use strict';
const net = require('net');
const crypto = require('crypto');

const token = process.argv[2] || '';
const host = process.argv[3] || '127.0.0.1';

function probe(label, port, path, originHost) {
  return new Promise((resolve) => {
    const c = net.connect(port, host);
    let buf = '';
    let done = false;
    const finish = (note) => { if (done) return; done = true; try { c.destroy(); } catch (_) {} resolve(label + ' -> ' + note); };
    c.setTimeout(7000);
    c.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      c.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + originHost + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    c.on('data', (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0 && !done) {
        const status = buf.split('\r\n')[0];
        const after = Buffer.byteLength(buf.slice(i + 4), 'latin1');
        finish(status + '  (头部后 ' + after + ' 字节)');
      } else if (buf.length > 20000) finish('响应过大');
    });
    c.on('timeout', () => finish('[超时] 已收 ' + buf.length + ' 字节'));
    c.on('error', (e) => finish('错误 ' + e.message));
  });
}

(async () => {
  console.log(await probe('直连分发服务 127.0.0.1:19392/ws', 19392, '/ws', '127.0.0.1:19392'));
  console.log(await probe('面板转发    :19390/dispatch/ws', 19390, '/dispatch/ws?t=' + encodeURIComponent(token), host + ':19390'));
  console.log(await probe('画面通道    :19390/ws', 19390, '/ws?t=' + encodeURIComponent(token), host + ':19390'));
  console.log(await probe('dsh 转发    :19391/api/events.host', 19391, '/api/events.host', host + ':19391'));
})();
