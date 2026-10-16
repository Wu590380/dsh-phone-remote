#!/usr/bin/env node
/*
 * 任务分发通道自测：连 /dispatch/ws，提交一个任务，实时打印推送的内容。
 * 用法: node tools/dispatch-selftest.js <令牌> [主机] [面板端口] "任务文本"
 */
'use strict';
const net = require('net');
const crypto = require('crypto');
const http = require('http');

const token = process.argv[2] || '';
const host = process.argv[3] || '127.0.0.1';
const port = parseInt(process.argv[4] || '19390', 10);
const prompt = process.argv[5] || '用一句话回答：1+1 等于几';

function encode(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xFE; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xFF; header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length >>> 0, 6); }
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, out]);
}

function post(path, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host, port, path: path + '?t=' + encodeURIComponent(token), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', d => s += d);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({ ok: false, raw: s }); } });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end(data);
  });
}

const sock = net.connect(port, host);
const key = crypto.randomBytes(16).toString('base64');
let stage = 'hs';
let pending = Buffer.alloc(0);
let ownId = null;
const shots = [];

sock.on('connect', () => {
  sock.write('GET /dispatch/ws?t=' + encodeURIComponent(token) + ' HTTP/1.1\r\nHost: ' + host + ':' + port +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
});

function onMsg(m) {
  if (m.type === 'init') {
    console.log('WS 已连上，历史任务 ' + (m.tasks || []).length + ' 个');
    post('/dispatch/api/task', { prompt, title: '自测任务' }).then(r => {
      if (!r.ok) { console.log('提交失败: ' + JSON.stringify(r)); process.exit(1); }
      ownId = r.task.id;
      console.log('已提交任务 ' + ownId + '（' + r.task.title + '）');
    });
    return;
  }
  if (m.type !== 'task') return;
  if (m.id && ownId && m.id !== ownId) return;
  if (m.action === 'started' || m.action === 'created') console.log('[状态] ' + m.task.status);
  else if (m.action === 'output') process.stdout.write(m.chunk);
  else if (m.action === 'ended') { console.log('\n[结束] ' + m.task.status + ' 退出码 ' + m.task.exitCode); finish(); }
}

function finish() { try { sock.destroy(); } catch (_) {} setTimeout(() => process.exit(0), 200); }

sock.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  if (stage === 'hs') {
    const i = pending.indexOf('\r\n\r\n');
    if (i < 0) return;
    console.log('握手: ' + pending.slice(0, i).toString('utf8').split('\r\n')[0]);
    pending = pending.slice(i + 4);
    stage = 'frames';
  }
  let more = true;
  while (more) {
    more = false;
    if (pending.length < 2) break;
    let len = pending[1] & 0x7f, off = 2;
    if (len === 126) { if (pending.length < 4) break; len = pending.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (pending.length < 10) break; len = Number(pending.readBigUInt64BE(2)); off = 10; }
    if (pending.length < off + len) break;
    const payload = pending.slice(off, off + len);
    pending = pending.slice(off + len);
    more = true;
    try { onMsg(JSON.parse(payload.toString('utf8'))); } catch (_) {}
  }
});

sock.on('error', e => { console.log('连接错误: ' + e.message); process.exit(1); });
setTimeout(() => { console.log('\n[超时退出]'); process.exit(0); }, 300000);
