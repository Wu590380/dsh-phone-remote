#!/usr/bin/env node
/*
 * 手机远程控制面板 —— 单文件 Node 服务（零第三方依赖）
 *   HTTP + WebSocket 面板：http://<电脑IP>:19390/?t=<TOKEN>
 *   同时把只监听 127.0.0.1 的 dsh 桌面网页 GUI 转发到局域网：http://<电脑IP>:19391/
 *
 * 功能：
 *   - 实时看电脑屏幕（GDI 截图 -> JPEG -> WebSocket 推流）
 *   - 手机触屏 = 鼠标（点按=左键，长按=右键，滑动=移动，双指滚动=滚轮）
 *   - 文本下发到电脑（回车/中英文输入）
 *   - 一键执行命令 / 运行预设（PowerShell），输出实时回传手机
 *   - 把指令写进工作区指令队列文件，dsh 会话可直接读取
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const TOKEN = (process.env.MC_TOKEN || '').trim() || 'changeme';
const PORT = parseInt(process.env.MC_PORT || '19390', 10);
const RELAY_PORT = parseInt(process.env.MC_RELAY_PORT || '19391', 10);
const RELAY_TARGET_PORT = parseInt(process.env.MC_RELAY_TARGET || '19387', 10);
const SHOT_WIDTH = parseInt(process.env.MC_SHOT_WIDTH || '1000', 10);
const SHOT_QUALITY = parseInt(process.env.MC_SHOT_QUALITY || '55', 10);
const FPS_MS = parseInt(process.env.MC_FPS_MS || '500', 10);
const EXEC_TIMEOUT_MS = parseInt(process.env.MC_EXEC_TIMEOUT || '600000', 10);

const PWSH = process.env.MC_PWSH || 'powershell.exe';
const SHOT_SCRIPT = path.join(ROOT, 'shot.ps1');
const SHOTD_EXE = path.join(ROOT, 'shotd.exe');
const STREAM_FPS = parseInt(process.env.MC_STREAM_FPS || '20', 10);
const INPUT_SCRIPT = path.join(ROOT, 'input.ps1');
const PRESET_FILE = path.join(ROOT, 'presets.json');
const INBOX_FILE = path.join(ROOT, 'inbox.md');
const LOG_FILE = path.join(ROOT, 'agent.log');
const WORKDIR = process.env.MC_WORKDIR || path.resolve(ROOT, '..');

/* ------------------------------- 基础工具 ------------------------------- */

function log(...a) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' +
    a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function runPwsh(script, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const ps = spawn(PWSH, ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args || []), {
      windowsHide: true, cwd: opts.cwd || ROOT,
    });
    const chunks = [];
    const errs = [];
    const t = setTimeout(() => { try { ps.kill(); } catch (_) {} }, opts.timeout || 20000);
    ps.stdout.on('data', d => chunks.push(d));
    ps.stderr.on('data', d => errs.push(d));
    ps.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errs).toString('utf8') });
    });
    ps.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e && e.message) }); });
  });
}

/* ------------------------------ 屏幕截图流 ------------------------------ */

const screen = { w: 1536, h: 960, scale: 1 };
let lastFrame = null;
let lastFrameAt = 0;
let capturing = false;
let streamClients = new Set();
let streaming = false;

async function capture() {
  if (capturing) return;
  capturing = true;
  try {
    const r = await runPwsh(SHOT_SCRIPT, ['-Width', String(SHOT_WIDTH), '-Quality', String(SHOT_QUALITY)], { timeout: 15000 });
    const buf = r.stdout;
    const nl = buf.indexOf(0x0a);
    if (nl <= 0) { log('capture: 无输出', r.stderr.slice(0, 200)); return; }
    const meta = JSON.parse(buf.slice(0, nl).toString('utf8'));
    screen.w = meta.ow; screen.h = meta.oh; screen.scale = meta.scale;
    lastFrame = buf.slice(nl + 1);
    lastFrameAt = Date.now();
  } catch (e) {
    log('capture 失败', e && e.message);
  } finally {
    capturing = false;
  }
}

  /* ---------- 常驻采集进程 shotd.exe：不再每帧起 PowerShell（原来 ~2 秒/帧 → 现在 20+ fps） ---------- */
  let shotd = null, shotdBuf = Buffer.alloc(0), metaSeen = false;
  let frameCount = 0, frameCountAt = Date.now(), curFps = 0;

  function startShotd() {
    if (shotd) return;
    if (!fs.existsSync(SHOTD_EXE)) { log('shotd.exe 不存在，回退 shot.ps1'); return; }
    try {
      shotd = spawn(SHOTD_EXE, ['--width', String(SHOT_WIDTH), '--quality', String(SHOT_QUALITY), '--fps', String(STREAM_FPS)], { windowsHide: true });
    } catch (e) { log('shotd 启动失败', e.message); shotd = null; return; }
    metaSeen = false; shotdBuf = Buffer.alloc(0);
    shotd.stdout.on('data', onShotdData);
    shotd.stderr.on('data', d => { const s = d.toString().trim(); if (s) log('shotd:', s.slice(0, 160)); });
    shotd.on('exit', code => {
      shotd = null; shotdBuf = Buffer.alloc(0);
      log('shotd 退出 code=' + code + '，2 秒后重启');
      setTimeout(() => { if (!shotd) startShotd(); }, 2000);
    });
    log('常驻采集已启动 shotd.exe（' + SHOT_WIDTH + ' 宽 / 质量 ' + SHOT_QUALITY + ' / 目标 ' + STREAM_FPS + 'fps）');
  }

  function onShotdData(d) {
    shotdBuf = Buffer.concat([shotdBuf, d]);
    if (!metaSeen) {
      const nl = shotdBuf.indexOf(0x0a);
      if (nl < 0) return;
      try { const m = JSON.parse(shotdBuf.slice(0, nl).toString('utf8')); screen.w = m.ow; screen.h = m.oh; } catch (_) {}
      shotdBuf = shotdBuf.slice(nl + 1);
      metaSeen = true;
    }
    while (shotdBuf.length >= 4) {
      const len = shotdBuf.readUInt32LE(0);
      if (len <= 0 || len > 20 * 1024 * 1024) { shotdBuf = Buffer.alloc(0); return; }
      if (shotdBuf.length < 4 + len) break;
      lastFrame = shotdBuf.slice(4, 4 + len);
      lastFrameAt = Date.now();
      shotdBuf = shotdBuf.slice(4 + len);
      frameCount++;
      pushFrame();
    }
    if (shotdBuf.length > 40 * 1024 * 1024) shotdBuf = Buffer.alloc(0);
  }

  /** 推帧：二进制给 App；旧网页降频走 base64；客户端跟不上就丢帧（保延迟） */
  function pushFrame() {
    const now = Date.now();
    if (now - frameCountAt >= 1000) {
      curFps = Math.round(frameCount * 1000 / (now - frameCountAt));
      frameCount = 0; frameCountAt = now;
    }
    if (!lastFrame || streamClients.size === 0) return;
    for (const c of streamClients) {
      if (c.destroyed) continue;
      if ((c.writableLength || 0) > 1500 * 1024) continue;
      if (c._binWs) {
        c.write(wsFrame(lastFrame, true));
      } else if (now - (c._lastJson || 0) >= 250) {
        c._lastJson = now;
        c.write(wsFrame(Buffer.from(JSON.stringify({ type: 'frame', ts: lastFrameAt, w: screen.w, h: screen.h, jpg: lastFrame.toString('base64') }), 'utf8')));
      }
    }
  }

async function streamLoop() {
  if (streaming) return;
  streaming = true;
  while (streamClients.size > 0) {
    await capture();
    if (lastFrame) {
      const b64 = lastFrame.toString('base64');
      const payload = JSON.stringify({ type: 'frame', ts: lastFrameAt, w: screen.w, h: screen.h, jpg: b64 });
      for (const c of streamClients) if (!c.destroyed) c.write(wsFrame(Buffer.from(payload, 'utf8')));
    }
    await new Promise(r => setTimeout(r, FPS_MS));
  }
  streaming = false;
}

/* ------------------------------- 命令执行 ------------------------------- */

const history = []; // {id,cmd,started,ended,code,output}
const MAX_HISTORY = 60;
let running = null;

function pushHistory(h) {
  history.push(h);
  while (history.length > MAX_HISTORY) history.shift();
}

function broadcast(obj) {
  const frame = wsFrame(Buffer.from(JSON.stringify(obj), 'utf8'));
  for (const c of streamClients) if (!c.destroyed) c.write(frame);
}

function runCommand(cmd, label) {
  const id = crypto.randomBytes(4).toString('hex');
  const rec = { id, cmd, label: label || '', started: Date.now(), ended: 0, code: null, output: '', pid: null };
  pushHistory(rec);
  broadcast({ type: 'cmd', phase: 'start', id, cmd, label: rec.label });
  log('exec', id, cmd);

  const ps = spawn(PWSH, ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command',
    '$ErrorActionPreference="Continue"; [Console]::OutputEncoding=[Text.Encoding]::UTF8;' + cmd],
    { cwd: WORKDIR, windowsHide: true });
  rec.pid = ps.pid;
  running = ps;

  const feed = (d) => {
    const s = d.toString('utf8');
    rec.output += s;
    if (rec.output.length > 400000) rec.output = rec.output.slice(-300000);
    broadcast({ type: 'cmd', phase: 'out', id, chunk: s });
  };
  ps.stdout.on('data', feed);
  ps.stderr.on('data', feed);

  const killer = setTimeout(() => { try { ps.kill(); feed('[[超时终止]]\n'); } catch (_) {} }, EXEC_TIMEOUT_MS);
  ps.on('close', (code) => {
    clearTimeout(killer);
    rec.code = code; rec.ended = Date.now(); running = null;
    broadcast({ type: 'cmd', phase: 'end', id, code, ms: rec.ended - rec.started });
    log('exec-done', id, 'code=' + code);
  });
  ps.on('error', (e) => { feed('[启动失败] ' + e.message + '\n'); });
  return rec;
}

/* ------------------------------- WebSocket ------------------------------- */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsFrame(buf, bin) {
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2); header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
  }
  header[0] = bin ? 0x82 : 0x81;
  return Buffer.concat([header, buf]);
}

function attachWs(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  log('ws 连接来自 ' + (req.socket.remoteAddress || '?') + ' host=' + (req.headers.host || '?'));
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  streamClients.add(socket);
  socket._binWs = /[?&]bin=1/.test(req.url || '');

  const send = (obj) => { if (!socket.destroyed) socket.write(wsFrame(Buffer.from(JSON.stringify(obj), 'utf8'))); };
  send({ type: 'hello', w: screen.w, h: screen.h, history: history.slice(-5), relaunch: process.env.MC_RELAUNCH || '' });
  if (lastFrame && !socket._binWs) send({ type: 'frame', ts: lastFrameAt, w: screen.w, h: screen.h, jpg: lastFrame.toString('base64') });
  if (socket._binWs && lastFrame) socket.write(wsFrame(lastFrame, true));
  startShotd();
  streamLoop();

  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) === 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.slice(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.slice(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      buf = buf.slice(need);
      if (op === 0x8) { socket.end(); return; }
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, 0x00])])); continue; }
      if (op !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { continue; }
      handleWsMessage(msg, send).catch(e => send({ type: 'err', msg: String(e && e.message) }));
    }
  });
  const drop = () => { streamClients.delete(socket); try { socket.destroy(); } catch (_) {} };
  socket.on('close', drop);
  socket.on('error', drop);
}

async function handleWsMessage(msg, send) {
  switch (msg.type) {
    case 'input':
      await doInput(msg.payload || {});
      break;
    case 'run': {
      const rec = runCommand(String(msg.cmd || '').slice(0, 4000), msg.label || '手机下发');
      send({ type: 'cmd', phase: 'start', id: rec.id, cmd: rec.cmd, label: rec.label, pid: rec.pid });
      break;
    }
    case 'ping':
      send({ type: 'pong', ts: Date.now() });
      break;
    case 'shot':
      await capture();
      if (lastFrame && !socket._binWs) send({ type: 'frame', ts: lastFrameAt, w: screen.w, h: screen.h, jpg: lastFrame.toString('base64') });
      if (socket._binWs && lastFrame) socket.write(wsFrame(lastFrame, true));
      startShotd();
      break;
    default:
      break;
  }
}

/* ---------------------- dsh 任务分发服务的转发与自启 --------------------- */

const DISPATCH_PORT = parseInt(process.env.MC_DISPATCH_PORT || '19392', 10);
let dispatchChild = null;

function ensureDispatcher() {
  const probe = net.connect(DISPATCH_PORT, '127.0.0.1');
  probe.setTimeout(1500);
  probe.on('connect', () => { probe.destroy(); });
  probe.on('timeout', () => probe.destroy());
  probe.on('error', () => {
    if (dispatchChild) return;
    const script = path.join(ROOT, 'tasks', 'dispatcher.js');
    if (!fs.existsSync(script)) { log('未找到任务分发服务: ' + script); return; }
    const env = { ...process.env, MC_DISPATCH_PORT: String(DISPATCH_PORT) };
    dispatchChild = spawn(process.execPath, [script], { cwd: path.dirname(script), env, windowsHide: true, stdio: 'ignore' });
    dispatchChild.on('exit', (code) => { log('任务分发服务退出 code=' + code); dispatchChild = null; });
    log('已拉起任务分发服务 (PID ' + dispatchChild.pid + ')');
  });
}

/* ---------------- 命名隧道看护（掉了自动拉起） ----------------
 * 之前踩过的坑：cloudflared 的 QUIC(UDP) 注册会超时（机器上有 utun8 / Radmin 虚拟网卡时尤其容易），
 * 隧道进程看着还在，但公网全是 530，手机那边就"连不上电脑"。这里：
 *   1) 每 60 秒检查「带 config.yml 的 cloudflared 进程」是否存活，不在就按 --protocol http2 拉起；
 *   2) 每 5 分钟真的探一次公网 /health，连续两次不通就重启隧道进程。
 * 用 --protocol http2 是因为本机 QUIC 注册会 timeout（实测）。
 */
const TUNNEL_CF = process.env.MC_CLOUDFLARED || 'C:\\Users\\your-user\\.dsh\\dsh-pocket\\bin\\cloudflared.exe';
const TUNNEL_CFG = process.env.MC_TUNNEL_CONFIG || path.join(os.homedir(), '.cloudflared', 'config.yml');
const TUNNEL_URL = process.env.MC_TUNNEL_HEALTH || 'https://mcp.example.com/health';
let tunnelChild = null;
let tunnelFails = 0;
let tunnelCheckedOnce = false;
let tunnelBusy = false;

function tunnelProcAlive() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -like '*config.yml*' } | Measure-Object).Count`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.on('close', () => resolve(parseInt(out.trim() || '0', 10) > 0));
    ps.on('error', () => resolve(true));
    setTimeout(() => { try { ps.kill(); } catch (_) {} resolve(true); }, 8000);
  });
}

function publicHealth() {
  return new Promise((resolve) => {
    const mod = TUNNEL_URL.startsWith('https:') ? require('https') : http;
    const req = mod.request(TUNNEL_URL, { method: 'GET', timeout: 15000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function startTunnel(reason) {
  if (tunnelChild) { try { tunnelChild.kill(); } catch (_) {} tunnelChild = null; }
  if (!fs.existsSync(TUNNEL_CF) || !fs.existsSync(TUNNEL_CFG)) { log('隧道看护: 找不到 cloudflared 或 config.yml，跳过'); return; }
  const a = ['tunnel', '--protocol', 'http2', '--config', TUNNEL_CFG, 'run'];
  tunnelChild = spawn(TUNNEL_CF, a, { windowsHide: true, stdio: 'ignore', detached: false });
  tunnelChild.on('exit', (code) => { log('隧道退出 code=' + code); tunnelChild = null; });
  log('隧道看护: 已拉起命名隧道（' + reason + '）PID ' + tunnelChild.pid);
}

async function ensureTunnel() {
  if (tunnelBusy) return;
  tunnelBusy = true;
  try {
    const alive = await tunnelProcAlive();
    if (!alive) { startTunnel('进程不在了'); tunnelFails = 0; return; }
    const ok = await publicHealth();
    if (ok) {
      if (tunnelFails) log('隧道看护: 公网已恢复');
      if (!tunnelCheckedOnce) { tunnelCheckedOnce = true; log('隧道看护: 首次探活通过 ' + TUNNEL_URL); }
      tunnelFails = 0;
      return;
    }
    tunnelFails++;
    log('隧道看护: 公网探活失败 ' + tunnelFails + '/2 (' + TUNNEL_URL + ')');
    if (tunnelFails >= 2) {
      // 进程在但公网不通（QUIC 注册超时是典型症状）→ 杀掉重来，强制走 http2
      spawn('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -like '*config.yml*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
        { windowsHide: true, stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 3000));
      startTunnel('公网不通，重启');
      tunnelFails = 0;
    }
  } finally { tunnelBusy = false; }
}

/* ---------------- 命名隧道看护 结束 ---------------- */

// /dispatch/... 与 /dispatch/ws 反向代理到 127.0.0.1:DISPATCH_PORT
function proxyDispatch(req, res) {
  const rest = req.url.replace(/^\/dispatch/, '') || '/';
  const up = http.request({ host: '127.0.0.1', port: DISPATCH_PORT, path: rest, method: req.method, headers: { ...req.headers, host: '127.0.0.1:' + DISPATCH_PORT } },
    (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); });
  up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }); } res.end(JSON.stringify({ ok: false, error: '分发服务不可用: ' + e.message })); });
  req.pipe(up);
}

function attachDispatchWs(req, socket, head) {
  const up = net.connect(DISPATCH_PORT, '127.0.0.1');
  const killTimer = setTimeout(() => { try { socket.destroy(); } catch (_) {} try { up.destroy(); } catch (_) {} }, 15000);
  up.on('connect', () => {
    up.write('GET /ws HTTP/1.1\r\n' +
      'Host: 127.0.0.1:' + DISPATCH_PORT + '\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + req.headers['sec-websocket-key'] + '\r\n' +
      'Sec-WebSocket-Version: ' + (req.headers['sec-websocket-version'] || '13') + '\r\n\r\n');
    if (head && head.length) up.write(head);
  });
  const close = () => { clearTimeout(killTimer); try { socket.destroy(); } catch (_) {} try { up.destroy(); } catch (_) {} };
  socket.pipe(up); up.pipe(socket);
  up.on('data', () => clearTimeout(killTimer));
  socket.on('error', close); up.on('error', close);
  socket.on('close', close); up.on('close', close);
}

/* -------------------------------- 输入注入 ------------------------------- */

async function doInput(p) {
  const a = String(p.action || p.a || '');
  if (!a) return { ok: false, error: 'no-action' };
  const args = ['-Action', a];
  if (p.x !== undefined) args.push('-X', String(clamp(Math.round(Number(p.x)), 0, screen.w - 1)));
  if (p.y !== undefined) args.push('-Y', String(clamp(Math.round(Number(p.y)), 0, screen.h - 1)));
  if (p.dx !== undefined) args.push('-DX', String(clamp(Math.round(Number(p.dx)), -10000, 10000)));
  if (p.dy !== undefined) args.push('-DY', String(clamp(Math.round(Number(p.dy)), -10000, 10000)));
  if (p.text !== undefined) args.push('-Text', String(p.text).slice(0, 4000));
  if (p.keys !== undefined) args.push('-Keys', String(p.keys).slice(0, 200));
  if (a === 'text' || a === 'clipboard') {
    const tmp = path.join(os.tmpdir(), 'mc-input-' + crypto.randomBytes(3).toString('hex') + '.txt');
    fs.writeFileSync(tmp, String(p.text || ''), 'utf8');
    args.push('-File', tmp);
  }
  const t0 = Date.now();
  const r = await runPwsh(INPUT_SCRIPT, args, { timeout: 25000 });
  log('input', a, 'code=' + r.code, (Date.now() - t0) + 'ms');
  return { ok: r.code === 0, stdout: r.stdout.toString('utf8').trim(), stderr: r.stderr.trim() };
}

function clamp(n, lo, hi) { return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }

/* --------------------------------- HTTP --------------------------------- */

function authOk(req, url) {
  const t = url.searchParams.get('t') || req.headers['x-mc-token'] || '';
  if (TOKEN === 'changeme') return true;
  const a = Buffer.from(String(t)); const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', d => { n += d.length; if (n > (limit || 300000)) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const PAGE = fs.readFileSync(path.join(ROOT, 'mobile.html'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    if (!authOk(req, url)) { res.writeHead(403); res.end('bad token'); return; }
    if (url.pathname === '/dispatch/ws') return attachDispatchWs(req, req.socket, Buffer.alloc(0));
    return attachWs(req, req.socket);
  }

  if (p === '/dispatch' || p.startsWith('/dispatch/')) {
    // 面板页面本身要令牌；分发接口沿用同一个令牌（浏览器第一个请求已带 t=）
    if (!authOk(req, url)) return json(res, 401, { ok: false, error: 'token 不正确' });
    return proxyDispatch(req, res);
  }

  if (p === '/' || p === '/mobile.html') {
    const withToken = Buffer.from(PAGE.toString('utf8').replace('__TOKEN__', TOKEN), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': withToken.length, 'Cache-Control': 'no-store' });
    return res.end(withToken);
  }

  if (!authOk(req, url)) return json(res, 401, { ok: false, error: 'token 不正确' });

  try {
    if (p === '/api/status') {
      return json(res, 200, {
        ok: true, screen, port: PORT, relayPort: RELAY_PORT, relayTarget: RELAY_TARGET_PORT, workdir: WORKDIR,
        clientCount: streamClients.size, lastFrameAt, fps: curFps, shotd: !!shotd, running: !!running,
        history: history.slice(-12).map(h => ({ id: h.id, cmd: h.cmd, label: h.label, code: h.code, ms: (h.ended || Date.now()) - h.started })),
        ips: localIps(),
      });
    }
    if (p === '/api/shot.jpg') {
      // 按需高清：?w=1920&q=90 临时抓一张原生分辨率清晰图（不动直播缓存帧）
      const wq = parseInt(url.searchParams.get('w') || '0', 10);
      const qq = parseInt(url.searchParams.get('q') || '0', 10);
      if (wq > 0 || qq > 0) {
        const rr = await runPwsh(SHOT_SCRIPT, ['-Width', String(wq > 0 ? wq : SHOT_WIDTH), '-Quality', String(qq > 0 ? qq : SHOT_QUALITY)], { timeout: 25000 });
        const bb = rr.stdout; const n2 = bb.indexOf(0x0a);
        if (n2 <= 0) return json(res, 503, { ok: false, error: 'capture failed' });
        const jj = bb.slice(n2 + 1);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jj.length, 'Cache-Control': 'no-store' });
        return res.end(jj);
      }
      if (!lastFrame || Date.now() - lastFrameAt > 3000) await capture();
      if (!lastFrame) return json(res, 503, { ok: false, error: 'capture failed' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': lastFrame.length, 'Cache-Control': 'no-store' });
      return res.end(lastFrame);
    }
    if (p === '/api/quality') {
      const w = parseInt(url.searchParams.get('w') || '0', 10);
      const q = parseInt(url.searchParams.get('q') || '0', 10);
      if (w > 0) process.env.MC_SHOT_WIDTH = String(w);
      if (q > 0) process.env.MC_SHOT_QUALITY = String(q);
      const nw = parseInt(process.env.MC_SHOT_WIDTH || '1000', 10);
      const nq = parseInt(process.env.MC_SHOT_QUALITY || '55', 10);
      try { if (shotd) { shotd.kill(); shotd = null; } } catch (_) {}
      setTimeout(() => startShotd(), 400);
      log('画质切换 → ' + nw + ' 宽 / 质量 ' + nq);
      return json(res, 200, { ok: true, width: nw, quality: nq });
    }
    if (p === '/api/presets') {
      return json(res, 200, { ok: true, presets: loadPresets() });
    }
    if (p === '/api/input') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await doInput(body);
      return json(res, r.ok ? 200 : 500, r);
    }
    if (p === '/api/run') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const cmd = String(body.cmd || '').trim();
      if (!cmd) return json(res, 400, { ok: false, error: '空命令' });
      const rec = runCommand(cmd, body.label || '手机下发');
      return json(res, 200, { ok: true, id: rec.id, pid: rec.pid, workdir: WORKDIR });
    }
    if (p === '/api/inbox') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text || '').slice(0, 8000);
      if (!text.trim()) return json(res, 400, { ok: false, error: '空内容' });
      const line = '- [' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + text.replace(/\r?\n/g, ' / ') + '\n';
      fs.appendFileSync(INBOX_FILE, line, 'utf8');
      return json(res, 200, { ok: true, file: INBOX_FILE, line });
    }
    if (p === '/api/kill') {
      if (running) { try { running.kill(); } catch (_) {} ; return json(res, 200, { ok: true, killed: true }); }
      return json(res, 200, { ok: true, killed: false });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e && e.message) });
  }
});

function loadPresets() {
  try { return JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8')); } catch (_) { return []; }
}

function localIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const k of Object.keys(ifaces)) {
    for (const a of ifaces[k] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: k, ip: a.address });
    }
  }
  return out;
}

/* ------------------------------ dsh 网页转发 ----------------------------- */
/*
 * dsh 的网页服务只用「回环权威」校验 Host/Origin：来自局域网、Host 写成电脑 IP
 * 的请求会被它判为不可信（403/401）。这里做一层带头部改写的 TCP 隧道：
 *   手机 -> 电脑:<RELAY_PORT> -> 改写 Host/Origin 为 127.0.0.1:<TARGET> -> dsh 网页
 * 这样既不用把 dsh 本体绑到 0.0.0.0，手机也能用完整网页界面。
 */
const LOOPBACK_AUTHORITY = '127.0.0.1:' + RELAY_TARGET_PORT;

/* ---- 自动给上游附加 dsh 的浏览器会话 cookie ----
 * 0.2.x 的 dsh web 用「authority + HMAC(secret)」签名 cookie 鉴权，secret 持久在 DSH_HOME 的
 * .credentials.yaml 里，所以这一层可以自己签发（tools/mint-dsh-cookie.js）。
 * 设 MC_RELAY_MINT_FROM=<某个 DSH_HOME> 即可：手机不需要知道 dsh 的 token，
 * 只要带转发令牌 t，cookie 由这一层统一补上。
 */
let relayCookie = '';
let relayCookieAt = 0;
function refreshRelayCookie() {
  const home = (process.env.MC_RELAY_MINT_FROM || '').trim();
  if (!home) { relayCookie = ''; return; }
  try {
    const { mint } = require('./tools/mint-dsh-cookie.js');
    const c = mint(home, LOOPBACK_AUTHORITY, 30);
    relayCookie = c.name + '=' + c.value;
    relayCookieAt = Date.now();
    log('已签发 dsh 会话 cookie（authority=' + c.authority + '，30 天有效）');
  } catch (e) {
    log('签发 dsh cookie 失败:', e && e.message);
    relayCookie = '';
  }
}
function ensureRelayCookie() {
  if (!relayCookie || Date.now() - relayCookieAt > 12 * 3600 * 1000) refreshRelayCookie();
}

// 转发端口的独立令牌（可用 MC_RELAY_TOKEN 单独设置；不设就沿用面板令牌）
const RELAY_TOKEN = (process.env.MC_RELAY_TOKEN || '').trim() || TOKEN;
const RELAY_COOKIE = 'mc_dsh';

function tokenEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** 这套转发是要暴露到公网的（家里电脑上的 dsh 网页），所以必须过令牌 */
function relayAuth(head, peer) {
  const line = head.split('\r\n')[0] || '';
  const m = /^[A-Z]+ (\S+)/.exec(line);
  const target = m ? m[1] : '/';
  const q = target.indexOf('?');
  const query = q >= 0 ? new URLSearchParams(target.slice(q + 1)) : new URLSearchParams();
  const cookie = /(?:^|\r\n)cookie:\s*([^\r\n]*)/i.exec(head);
  const cookies = new URLSearchParams((cookie ? cookie[1] : '').replace(/;\s*/g, '&'));
  const headerTok = /(?:^|\r\n)x-mc-token:\s*([^\r\n]*)/i.exec(head);
  const hostHdr = (/^\s*host:\s*([^\r\n]+)/im.exec(head) || [])[1] || '';
  // 注意：cloudflared 也是从本机连过来的，所以「回环来源」不能单独作为免检依据；
  // 必须连 Host 也是回环（说明是这台电脑上的浏览器/脚本直接访问），才免令牌。
  const hostIsLoopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(hostHdr.trim());
  const peerIsLoopback = /^(::1|127\.|::ffff:127\.)/.test(peer || '');
  if (peerIsLoopback && hostIsLoopback) return { ok: true, local: true };
  if (tokenEq(query.get('t') || '', RELAY_TOKEN)) {
    return { ok: true, setCookie: true, path: target.slice(0, q < 0 ? target.length : q) };
  }
  if (tokenEq(cookies.get(RELAY_COOKIE) || '', RELAY_TOKEN)) return { ok: true };
  if (headerTok && tokenEq(headerTok[1].trim(), RELAY_TOKEN)) return { ok: true };
  return { ok: false };
}

function rewriteHead(head) {
  return head
    .replace(/\r\nhost:[^\r\n]*/i, '\r\nHost: ' + LOOPBACK_AUTHORITY)
    .replace(/\r\norigin:[^\r\n]*/i, '\r\nOrigin: http://' + LOOPBACK_AUTHORITY);
}

/* ---- 手机端专用样式注入（只在这个转发端口生效，网页本身不受影响）----
 * 1) 隐藏「思考过程」块（ReasoningRow 的类名前缀 QWLzlG_）
 * 2) 窄屏时把左侧「工作区/会话」侧栏改成浮层：展开时盖在对话上，不再把对话挤没
 */
const PHONE_CSS = [
  '[class*="QWLzlG_"]{display:none !important}',
  '@media (max-width: 900px){',
  '  .pI_x6G_frame{grid-template-columns:0px minmax(0,1fr) 0px !important}',
  '  .pI_x6G_sidebarCol{position:absolute !important;top:0;bottom:0;left:0;width:min(82vw,320px) !important;',
  '    z-index:60 !important;box-shadow:0 12px 40px rgba(0,0,0,.55) !important;transition:transform .22s ease !important;',
  '    transform:translateX(-102%)}',
  '  .pI_x6G_frame:not([data-sidebar-collapsed]) .pI_x6G_sidebarCol{transform:translateX(0)}',
  '}',
  '@media (max-width: 560px){body{-webkit-text-size-adjust:100%}}',
].join('\n');
const PHONE_STYLE_TAG = '<style id="mc-phone-ui" data-by="mobile-control">\n' + PHONE_CSS + '\n</style>\n';

// 让这个界面能被 Chrome 当 App 安装/加主屏：只提供一个「存在但不拦截」的 fetch 处理器。
// 注意：**绝不能在 fetch 里 respondWith** —— 任何转发/缓存都会让凭证与鉴权出现意外，
// 之前用"透传 fetch"造成了页面反复加载失败（401 循环）。
const PHONE_SW_JS = [
  '/* mobile-control: 空 fetch 处理器，只为满足"可安装"判定，不拦截、不缓存任何请求 */',
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));",
  "self.addEventListener('fetch', () => { /* 故意不调用 respondWith：完全交给浏览器 */ });",
  '',
].join('\n');

const PHONE_SW_TAG =
  '<script id="mc-phone-sw" data-by="mobile-control">\n' +
  "if ('serviceWorker' in navigator) { addEventListener('load', () => { navigator.serviceWorker.register('/mc-sw.js').catch(() => {}); }); }\n" +
  '</script>\n';

// 手机端排障浮层：把 readyState / 异常 / 失败的 fetch 直接画在页面上（截屏即可读，不依赖上报网络）
const PHONE_ERR_TAG =
  '<script id="mc-phone-err" data-by="mobile-control">\n' +
  '(function(){\n' +
  'var L=[];function put(s){L.push(new Date().toISOString().slice(11,19)+" "+s);if(L.length>14)L.shift();var d=document.getElementById("mc-diag");' +
  'if(!d){d=document.createElement("div");d.id="mc-diag";d.style.cssText="position:fixed;left:0;right:0;top:0;z-index:2147483647;background:rgba(0,0,0,.86);color:#7CFC98;font:11px/1.45 monospace;padding:6px 8px;max-height:46vh;overflow:auto;white-space:pre-wrap";' +
  '(document.body||document.documentElement).appendChild(d);}d.textContent=L.join("\\n");document.title="MC:"+s;}\n' +
  'put("start rs="+document.readyState);\n' +
  'addEventListener("error",function(e){if(e&&e.target&&(e.target.src||e.target.href)){put("RES FAIL "+String(e.target.src||e.target.href).slice(-70));}else{put("ERR "+(e&&e.message)+" @"+String(e&&e.filename).split("/").pop()+":"+(e&&e.lineno));}},true);\n' +
  'addEventListener("unhandledrejection",function(e){put("REJ "+(((e&&e.reason&&(e.reason.stack||e.reason.message))||e.reason)||"")+"");});\n' +
  'var of=window.fetch;if(of){window.fetch=function(){var u=String((arguments[0]&&arguments[0].url)||arguments[0]);var p=of.apply(this,arguments);try{p.then(function(r){if(!r.ok)put("HTTP "+r.status+" "+u.slice(-60));},function(e){put("FETCH ERR "+u.slice(-50)+" "+((e&&e.message)||e));});}catch(e){}return p;};}\n' +
  'var oe=console.error;console.error=function(){put("CONSOLE "+Array.prototype.join.call(arguments," ").slice(0,200));return oe.apply(console,arguments);};\n' +
  'addEventListener("DOMContentLoaded",function(){put("DOMContentLoaded scripts="+document.scripts.length);try{var ml=window.__ModuleLoader__;if(ml&&typeof ml.load==="function"){window.__reg=[];var ol=ml.load.bind(ml);ml.load=function(r){window.__reg.push((r&&r.id)||"?");put("REG["+window.__reg.length+"] "+((r&&r.id)||"?"));return ol(r);};put("已挂钩 ModuleLoader.load");}else{put("没有 __ModuleLoader__");}}catch(e){put("挂钩失败 "+e.message);}});\n' +
  'setInterval(function(){var n=0;for(var i=0;i<document.scripts.length;i++){if(document.scripts[i].src)n++;}put("tick rs="+document.readyState+" boot="+(typeof window.__DSH_BOOT__)+" scripts="+document.scripts.length+"/src="+n+" reg="+((window.__reg&&window.__reg.length)||0)+" body="+(document.body?document.body.childElementCount:"-"));},3000);\n' +
  '})();\n' +
  '</script>\n';

function injectPhoneCss(body) {
  if (!body || body.indexOf('mc-phone-ui') >= 0) return body;
  const extra = PHONE_SW_TAG + (process.env.MC_RELAY_DEBUG ? PHONE_ERR_TAG : '');
  // 排障探针必须最早执行：插到 <head> 之后（比应用自己的 boot 脚本更早）
  let out = body;
  const h = out.indexOf('<head>');
  if (h >= 0) out = out.slice(0, h + 6) + (process.env.MC_RELAY_DEBUG ? PHONE_ERR_TAG : '') + out.slice(h + 6);
  const i = out.indexOf('</head>');
  const tail = PHONE_STYLE_TAG + PHONE_SW_TAG;
  return i < 0 ? tail + out : out.slice(0, i) + tail + out.slice(i);
}

/** 改写往手机端下发的 manifest：全屏 + 带令牌的 start_url + 自带图标 */
function patchManifest(text) {
  try {
    const m = JSON.parse(text);
    m.name = '电脑 dsh';
    m.short_name = '电脑 dsh';
    m.scope = '/';
    m.start_url = '/?t=' + RELAY_TOKEN;
    m.display = 'fullscreen';
    m.icons = [
      { src: '/mc-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/mc-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ];
    return JSON.stringify(m, null, 2);
  } catch (_) { return text; }
}

/** HTTP 版令牌校验（cookie / ?t= / X-MC-Token；来源与 Host 都是回环才免检） */
function relayAuthHttp(req, url) {
  const hostHdr = String(req.headers.host || '');
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const hostIsLoopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(hostHdr.trim());
  const peerIsLoopback = /^(::1|127\.|::ffff:127\.)/.test(peer);
  if (peerIsLoopback && hostIsLoopback) return { ok: true, local: true };
  if (tokenEq(url.searchParams.get('t') || '', RELAY_TOKEN)) {
    // 只去掉转发令牌 t，其余参数（例如 dsh 自己的 ?token=<启动令牌>）必须保留，
    // 否则 dsh 换不到它的会话 cookie。
    const keep = new URLSearchParams(url.searchParams);
    keep.delete('t');
    const qs = keep.toString();
    return { ok: true, setCookie: true, path: url.pathname + (qs ? '?' + qs : '') };
  }
  const cookie = /(?:^|;\s*)mc_dsh=([^;]+)/.exec(String(req.headers.cookie || ''));
  if (cookie && tokenEq(decodeURIComponent(cookie[1]), RELAY_TOKEN)) return { ok: true };
  if (tokenEq(String(req.headers['x-mc-token'] || ''), RELAY_TOKEN)) return { ok: true };
  return { ok: false };
}

const _pending = new Map();
function startLog(u) {
  const key = String(u);
  _pending.set(key, Date.now());
  log('请求开始', key.slice(0, 70));
  setTimeout(() => { if (_pending.has(key)) { log('⚠️ 从未返回', key.slice(0, 70), '已等 ' + Math.round((Date.now() - _pending.get(key)) / 1000) + 's'); } }, 15000);
}

const relay = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const auth = relayAuthHttp(req, url);
  if (!auth.ok) {
    log('转发被拒(令牌不对)', (req.socket.remoteAddress || ''), req.method, url.pathname);
    // 页面导航时给一个「点一下就能进」的引导页（主屏快捷方式漏带令牌时很有用），
    // 其它资源请求保持 401，避免把无令牌请求当成资源放过去。
    const isNavigation = req.method === 'GET' && /^text\/html|^\*\/\*|^$/.test(String(req.headers.accept || ''));
    if (isNavigation) {
      const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>需要令牌</title><body style="margin:0;font:16px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;' +
        'background:#0e1016;color:#e6e9f0;display:flex;align-items:center;justify-content:center;min-height:100vh">' +
        '<div style="max-width:34em;padding:28px">' +
        '<h2 style="margin:0 0 12px">点一下进入（只需一次）</h2>' +
        '<p style="color:#9aa4b8">这台电脑上的 dsh 界面需要一枚令牌。点下面的按钮进入一次，之后这个设备 30 天内都不用再输。</p>' +
        '<p style="margin:22px 0"><a href="/?t=' + RELAY_TOKEN + '" style="display:inline-block;padding:12px 22px;border-radius:10px;' +
        'background:#3b6ef6;color:#fff;text-decoration:none;font-weight:600">进入电脑 dsh</a></p>' +
        '<p style="color:#66708a;font-size:13px">如果你是用主屏图标进来的：请先用普通浏览器打开带令牌的完整地址一次，' +
        '或删掉旧图标后重新「添加到主屏幕」。</p></div></body>';
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('需要令牌：先用 https://<你的域名>/?t=<令牌> 打开一次（会记住），或带 X-MC-Token 头。');
  }
  if (auth.setCookie) {
    res.writeHead(302, {
      Location: auth.path || '/',
      'Set-Cookie': RELAY_COOKIE + '=' + RELAY_TOKEN + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000',
      'Content-Length': 0,
    });
    return res.end();
  }

  ensureRelayCookie();

  // 本地直接提供的几个 PWA 辅助资源（sw / 图标），不走上游
  if (url.pathname === '/mc-log') {
    log('手机端上报', String(url.searchParams.get('k') || ''), String(url.searchParams.get('v') || '').slice(0, 220));
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (url.pathname === '/mc-sw.js') {
    const b = Buffer.from(PHONE_SW_JS, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    return res.end(b);
  }
  if (url.pathname === '/mc-icon-192.png' || url.pathname === '/mc-icon-512.png') {
    const f = path.join(ROOT, url.pathname.slice(1));
    if (fs.existsSync(f)) {
      const b = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': b.length, 'Cache-Control': 'max-age=86400' });
      return res.end(b);
    }
  }

  const headers = Object.assign({}, req.headers, {
    host: LOOPBACK_AUTHORITY,
    origin: 'http://' + LOOPBACK_AUTHORITY,
    referer: 'http://' + LOOPBACK_AUTHORITY + '/',
  });
  delete headers['accept-encoding'];   // 要明文 HTML 才能注入样式
  if (relayCookie) headers.cookie = relayCookie;   // 统一补上 dsh 的会话 cookie

  if (process.env.MC_RELAY_DEBUG) startLog(req.url);
  const up = http.request({ host: '127.0.0.1', port: RELAY_TARGET_PORT, path: req.url, method: req.method, headers }, (upRes) => {
    _pending.delete(String(req.url));
    if (process.env.MC_RELAY_DEBUG) log('转发', req.method, url.pathname.slice(0, 60), '->', upRes.statusCode, String(upRes.headers['content-length'] || '?') + 'B', String(upRes.headers['content-type'] || '').slice(0, 24));
    const ct = String(upRes.headers['content-type'] || '');
    const isManifest = ct.includes('manifest') || /\.webmanifest(\?|$)/.test(req.url);
    if (!ct.includes('text/html') && !isManifest) {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      return upRes.pipe(res);
    }
    const chunks = [];
    upRes.on('data', d => chunks.push(d));
    upRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = isManifest ? patchManifest(raw) : injectPhoneCss(raw);
      const h = Object.assign({}, upRes.headers);
      delete h['content-encoding']; delete h['transfer-encoding'];
      h['content-length'] = Buffer.byteLength(body);
      h['cache-control'] = 'no-store';
      if (isManifest) h['content-type'] = 'application/manifest+json; charset=utf-8';
      res.writeHead(upRes.statusCode || 200, h);
      res.end(body);
    });
  });
  up.on('error', (e) => {
    log('转发上游错误', e.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('转发上游不可用: ' + e.message + '（检查 ' + RELAY_TARGET_PORT + ' 端口的 dsh 网页是否在跑）');
  });
  req.pipe(up);
});

// WebSocket 升级：原样透传（只改头部权威）
relay.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (!relayAuthHttp(req, url).ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  ensureRelayCookie();
  const up = net.connect(RELAY_TARGET_PORT, '127.0.0.1');
  const headLines = ['GET ' + req.url + ' HTTP/1.1'];
  for (const [k, v] of Object.entries(req.headers)) {
    if (relayCookie && k.toLowerCase() === 'cookie') continue;   // 用我们自己签发的那份
    headLines.push(k + ': ' + v);
  }
  if (relayCookie) headLines.push('Cookie: ' + relayCookie);
  const rawHead = rewriteHead(headLines.join('\r\n') + '\r\n\r\n');
  up.on('connect', () => {
    up.write(Buffer.from(rawHead, 'latin1'));
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => { try { socket.destroy(); } catch (_) {} try { up.destroy(); } catch (_) {} };
  up.on('error', close); socket.on('error', close); up.on('close', close); socket.on('close', close);
});
relay.on('error', e => log('relay 错误', e.message));

/* --------------------------------- 启动 --------------------------------- */

server.listen(PORT, '0.0.0.0', () => {
  const ips = localIps();
  log('==================================================================');
  startShotd();
  log('手机控制面板已启动  PID=' + process.pid);
  log('工作目录: ' + WORKDIR);
  for (const { iface, ip } of ips) log('  手机访问: http://' + ip + ':' + PORT + '/?t=' + TOKEN + '     [' + iface + ']');
  log('  dsh 网页转发: http://<电脑IP>:' + RELAY_PORT + '/  -> 127.0.0.1:' + RELAY_TARGET_PORT);
  log('  任务分发转发: http://<电脑IP>:' + PORT + '/dispatch/  -> 127.0.0.1:' + DISPATCH_PORT);
  log('  指令队列文件: ' + INBOX_FILE);
  log('==================================================================');
  capture();
  ensureDispatcher();
});

relay.listen(RELAY_PORT, '0.0.0.0', () => log('dsh 网页转发监听 0.0.0.0:' + RELAY_PORT));
relay.listen(RELAY_PORT, '0.0.0.0', () => log('dsh 网页转发监听 0.0.0.0:' + RELAY_PORT));

// 隧道看护：60 秒查进程，5 分钟探公网（探活本身按 60 秒节流）
ensureTunnel();
setInterval(ensureTunnel, 60 * 1000);
setInterval(() => { if (tunnelChild === null) ensureTunnel(); }, 5 * 60 * 1000);

process.on('uncaughtException', e => log('uncaught', e && e.stack || String(e)));
process.on('unhandledRejection', e => log('unhandled', String(e)));
