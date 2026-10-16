#!/usr/bin/env node
/*
 * 验证「转发端口」是否真的能把 dsh 网页送到局域网：
 *   1) 用 Host=<电脑IP>:<转发端口> 取首页（应 200，且是 dsh 网页）
 *   2) 用同样的 Host 做一次 WebSocket 升级（应 101）
 *   3) 用 Host=<电脑IP>:<dsh网页端口> 直连（对比：应当是 401 / 连不上）
 * 用法: node _verify_relay.js <lanIp> <relayPort> <dshWebPort>
 */
'use strict';
const net = require('net');
const crypto = require('crypto');

const [lanIp, relayPort, dshWebPort] = [process.argv[2] || '192.168.31.165', parseInt(process.argv[3] || '19391', 10), parseInt(process.argv[4] || '19400', 10)];

function httpGet(port, hostHeader, path) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    let buf = '';
    c.setTimeout(6000);
    c.on('connect', () => {
      c.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    c.on('data', (d) => { buf += d.toString('utf8'); if (buf.length > 6000) c.destroy(); });
    c.on('close', () => resolve(buf));
    c.on('timeout', () => { c.destroy(); resolve(buf + '\n[timeout]'); });
    c.on('error', (e) => resolve('[error] ' + e.message));
  });
}

function wsUpgrade(port, hostHeader, path) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const c = net.connect(port, '127.0.0.1');
    let buf = '';
    c.setTimeout(6000);
    c.on('connect', () => {
      c.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://${hostHeader}\r\n\r\n`
      );
    });
    c.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('\r\n\r\n')) c.destroy(); });
    c.on('close', () => resolve(buf.split('\r\n')[0] || '[no response]'));
    c.on('timeout', () => { c.destroy(); resolve('[timeout]'); });
    c.on('error', (e) => resolve('[error] ' + e.message));
  });
}

// 对比：带上/不带令牌做一次控制面板的 WebSocket 升级，确认 101 是本进程给出的
function wsUpgradePanel(port, hostHeader, token) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const c = net.connect(port, '127.0.0.1');
    let buf = '';
    c.setTimeout(6000);
    c.on('connect', () => {
      c.write(
        `GET /ws?t=${encodeURIComponent(token)} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    c.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('\r\n\r\n')) c.destroy(); });
    c.on('close', () => resolve(buf.split('\r\n')[0] || '[no response]'));
    c.on('timeout', () => { c.destroy(); resolve('[timeout]'); });
    c.on('error', (e) => resolve('[error] ' + e.message));
  });
}

(async () => {
  const lan = `${lanIp}:${relayPort}`;
  const direct = `${lanIp}:${dshWebPort}`;

  const root = await httpGet(relayPort, lan, '/');
  const first = (root.split('\r\n')[0] || '').trim();
  const isDsh = root.includes('__DSH_BOOT__') || root.includes('dsh');
  console.log(`1) 转发端口取首页  http://${lan}/  ->  ${first}  dsh页面=${isDsh}`);

  const ws = await wsUpgrade(relayPort, lan, '/api/events.host');
  console.log(`2) 转发端口 WS 升级  ->  ${ws}`);

  const directRoot = await httpGet(dshWebPort, direct, '/');
  const directFirst = (directRoot.split('\r\n')[0] || '').trim();
  console.log(`3) 直连 dsh 网页端口（对照）  ->  ${directFirst}`);
})();
