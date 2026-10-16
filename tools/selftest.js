#!/usr/bin/env node
/*
 * 端到端自测（干净版）：连上控制面板的 WebSocket → 收画面帧 → 跑一条命令 → 做一次鼠标移动。
 * 用法: node tools\_selftest2.js <令牌> [主机] [端口]
 */
'use strict';
const net = require('net');
const crypto = require('crypto');

const token = process.argv[2] || '';
const host = process.argv[3] || '127.0.0.1';
const port = parseInt(process.argv[4] || '19390', 10);

const log = [];
function note(s) { log.push(s); }

function encode(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0xFE;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0xFF;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length >>> 0, 6);
  }
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, out]);
}

const sock = net.connect(port, host);
const key = crypto.randomBytes(16).toString('base64');
let stage = 'handshake';
let pending = Buffer.alloc(0);
let gotFrame = false;
let commandSent = false;

sock.on('connect', () => {
  sock.write(
    'GET /ws?t=' + encodeURIComponent(token) + ' HTTP/1.1\r\n' +
    'Host: ' + host + ':' + port + '\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
  );
});

function handleMessage(msg) {
  if (msg.type === 'hello') {
    note('hello: 屏幕 ' + msg.w + 'x' + msg.h);
    if (!commandSent) {
      commandSent = true;
      sock.write(encode({
        type: 'run',
        cmd: "Write-Output ('电脑时间 ' + (Get-Date -Format 'HH:mm:ss')); (Get-Location).Path",
        label: '自测'
      }));
      sock.write(encode({ type: 'input', payload: { action: 'move', x: 640, y: 400 } }));
    }
  } else if (msg.type === 'frame' && !gotFrame) {
    gotFrame = true;
    const head = Buffer.from((msg.jpg || '').slice(0, 12), 'base64').slice(0, 3).toString('hex');
    note('画面帧: ' + msg.w + 'x' + msg.h + '  base64 ' + (msg.jpg || '').length + ' 字符  JPEG头 ' + head);
    note('画面帧可用: ' + (head === 'ffd8ff'));
  } else if (msg.type === 'cmd' && msg.phase === 'out') {
    note('命令输出 | ' + msg.chunk.trim());
  } else if (msg.type === 'cmd' && msg.phase === 'end') {
    note('命令结束: code=' + msg.code + '  用时 ' + msg.ms + 'ms');
    done('全部通过');
  }
}

sock.on('data', (chunk) => {
  if (stage === 'handshake') {
    pending = Buffer.concat([pending, chunk]);
    const idx = pending.indexOf('\r\n\r\n');
    if (idx < 0) return;
    note('握手: ' + pending.slice(0, idx).toString('utf8').split('\r\n')[0]);
    pending = pending.slice(idx + 4);
    stage = 'frames';
    sock.write(encode({ type: 'shot' }));
  } else {
    pending = Buffer.concat([pending, chunk]);
  }
  let progress = true;
  while (progress) {
    progress = false;
    if (pending.length < 2) break;
    const b1 = pending[1];
    let len = b1 & 0x7F;
    let off = 2;
    if (len === 126) {
      if (pending.length < 4) break;
      len = pending.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (pending.length < 10) break;
      len = Number(pending.readBigUInt64BE(2));
      off = 10;
    }
    if (pending.length < off + len) break;
    const payload = pending.slice(off, off + len);
    pending = pending.slice(off + len);
    progress = true;
    try { handleMessage(JSON.parse(payload.toString('utf8'))); } catch (_) {}
  }
});

let finished = false;
function done(reason) {
  if (finished) return;
  finished = true;
  setTimeout(() => {
    console.log('---- 自测结果 (' + reason + ') ----');
    if (!log.length) console.log('  (没有收到任何消息)');
    for (const line of log) console.log('  ' + line);
    try { sock.destroy(); } catch (_) {}
    process.exit(0);
  }, 700);
}

sock.on('error', (e) => { note('连接错误: ' + e.message); done('连接错误'); });
setTimeout(() => done('超时'), 15000);
