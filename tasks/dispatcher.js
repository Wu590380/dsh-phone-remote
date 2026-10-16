#!/usr/bin/env node
/*
 * dsh 任务分发服务（手机下达 → 电脑桌面端 dsh 执行 → 结果回传手机）
 *
 * 执行方式：每个任务用 `dsh --profile headless "<任务文本>"` 起一个独立进程，
 *           输出（stdout/stderr）实时落盘并推给手机；一个任务一个持久会话，
 *           可以用 dsh 网页（转发端口）打开同一 DSH_HOME 继续追问。
 *
 * 端口的定位：只监听 127.0.0.1，由 agent 一并转发给手机，不单独暴露。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* --------------------------------- 配置 --------------------------------- */

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tasks');
const LOGS = path.join(DIR, 'logs');
const QUEUE_FILE = path.join(DIR, 'queue.json');
const PROC_LOG = path.join(DIR, 'dispatcher.log');
const TASK_HOME = process.env.MC_TASK_HOME || path.join(path.resolve(__dirname, '..'), 'dsh-home');
const SEEDED = path.join(TASK_HOME, '.seeded');

const PORT = parseInt(process.env.MC_DISPATCH_PORT || '19392', 10);
const HOST = '127.0.0.1';
const CONCURRENCY = parseInt(process.env.MC_DISPATCH_CONCURRENCY || '1', 10);
const TIMEOUT_MS = parseInt(process.env.MC_TASK_TIMEOUT_MS || String(30 * 60 * 1000), 10);
const WORKDIR = process.env.MC_TASK_WORKDIR || path.resolve(ROOT, '..');
const MODEL = process.env.MC_TASK_MODEL || 'deepseek-flash';
const EFFORT = process.env.MC_TASK_EFFORT || 'high';
const PROFILE = process.env.MC_TASK_PROFILE || 'headless';
const DSH_PS1 = process.env.MC_DSH_PS1 || 'E:\\node_global\\dsh.ps1';
const RUNNER_PS1 = path.join(__dirname, 'run-task.ps1');
const PWSH = process.env.MC_PWSH || 'powershell.exe';

for (const d of [DIR, LOGS, TASK_HOME]) fs.mkdirSync(d, { recursive: true });

/* ------------------------------ 日志与队列 ------------------------------ */

function log(...a) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' +
    a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(PROC_LOG, line + '\n'); } catch (_) {}
}

let queue = [];
let running = 0;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    queue = Array.isArray(raw.tasks) ? raw.tasks : [];
  } catch (_) { queue = []; }
  // 进程重启后，之前 running 的任务标记为中断
  for (const t of queue) if (t.status === 'running') { t.status = 'failed'; t.error = '分发服务重启，任务被中断'; t.endedAt = Date.now(); }
}
function save() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify({ tasks: queue.slice(-200), savedAt: Date.now() }, null, 1)); } catch (e) { log('save 失败', e.message); }
}

function logPath(id) { return path.join(LOGS, id + '.log'); }

function readLog(id, from) {
  try {
    const buf = fs.readFileSync(logPath(id));
    return { text: buf.slice(from || 0).toString('utf8'), size: buf.length };
  } catch (_) { return { text: '', size: from || 0 }; }
}

/* ------------------------------- 广播通道 ------------------------------- */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

function wsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  let header;
  if (payload.length < 126) { header = Buffer.alloc(2); header[1] = payload.length; }
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6); }
  header[0] = 0x81;
  return Buffer.concat([header, payload]);
}
function broadcast(obj) {
  const frame = wsFrame(JSON.stringify(obj));
  for (const c of clients) if (!c.destroyed) c.write(frame);
}

/* ---------------- 任务事件外发（可选，默认关闭） ----------------
 * 想在工作流里接通知就把 MC_NOTIFY_URL 指向任意能收 POST 的服务，
 * 例如企业微信机器人中转 / 自建 webhook；不设就完全不做外发。
 */
const NOTIFY_URL = process.env.MC_NOTIFY_URL || '';
const NOTIFY_USER = process.env.MC_NOTIFY_USER || '';

/* ---------------- 远程确认约定（问题回传到手机） ----------------
 * 派活时会在任务前拼一小段约定：需要用户拍板时不要擅自决定，而是按固定格式把问题吐出来并结束；
 * 任务结束后 dispatcher 扫日志，命中就把状态标成 needs_confirm，并抽出问题与选项。
 * 手机端的 dsh 看到 pendingQuestion 后，用自己的提问工具弹给用户选，
 * 再把「原任务 + 用户的选择」重新派一次（run_task 的 context 参数）。
 */
const CONFIRM_POLICY = process.env.MC_NO_CONFIRM_POLICY ? '' : [
  '【远程派活约定】你是被手机用户远程派到这台电脑上干活的，无人值守。执行中若遇到必须由用户拍板的决策：',
  '1) 不要擅自做决定，也不要试图提问；',
  '2) 直接输出下面两行，然后**立即结束任务**（不要继续做后面的步骤）：',
  'NEED_CONFIRM: <一句话说清要拍板什么>',
  '选项: A) <选项一> | B) <选项二> | C) <选项三>',
  '若不需要拍板，就正常把任务做完。',
  '',
].join('\n');

const CONFIRM_RE = /^\s*NEED_CONFIRM\s*[:：]\s*(.+?)\s*$/im;
const OPTIONS_RE = /^\s*选项\s*[:：]\s*(.+?)\s*$/im;

function extractQuestion(text) {
  const q = CONFIRM_RE.exec(text || '');
  if (!q) return null;
  const o = OPTIONS_RE.exec(text || '');
  return { question: q[1], options: o ? o[1] : '' };
}

function tailOf(id, n = 1200) {
  const l = readLog(id, 0);
  const text = l.text.replace(/\s+$/, '');
  return text.length <= n ? text : '…' + text.slice(-n);
}

function notify(event, task, extra) {
  if (!NOTIFY_URL) return;
  const payload = Object.assign({ event, task: taskView(task), user: NOTIFY_USER }, extra || {});
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const req = http.request(NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
    (res) => { res.resume(); });
  req.on('error', (e) => { if (process.env.MC_NOTIFY_DEBUG) log('通知外发失败（不影响任务）', e.message); });
  req.setTimeout(5000, () => req.destroy());
  req.end(body);
}
function taskView(t) {
  const elapsed = t.startedAt ? Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000) : 0;
  return {
    id: t.id, title: t.title, prompt: t.prompt, workdir: t.workdir, status: t.status,
    createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt, exitCode: t.exitCode,
    error: t.error || '', bytes: t.bytes || 0, pid: t.pid || null, elapsed,
    // 需要用户拍板时带出来（手机端 dsh 用它弹选择给用户）
    pendingQuestion: (t.pending && t.pending.question) || '',
    pendingOptions: (t.pending && t.pending.options) || '',
  };
}

/* -------------------------------- 任务执行 ------------------------------- */

function enqueue(input) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('任务内容为空');
  const context = String(input.context || '').trim();
  const fullPrompt = context ? prompt + '\n\n【补充上下文】\n' + context : prompt;
  const t = {
    id: crypto.randomBytes(5).toString('hex'),
    title: String(input.title || '').trim() || prompt.split(/\r?\n/)[0].slice(0, 40),
    prompt: fullPrompt,
    workdir: String(input.workdir || WORKDIR),
    status: 'pending',
    createdAt: Date.now(), startedAt: 0, endedAt: 0,
    exitCode: null, error: '', bytes: 0, pid: null,
  };
  fs.writeFileSync(logPath(t.id), '');
  queue.push(t);
  save();
  broadcast({ type: 'task', action: 'created', task: taskView(t) });
  notify('created', t);
  log('入队', t.id, t.title);
  pump();
  return t;
}

function appendLog(t, chunk) {
  const s = chunk.toString('utf8');
  t.bytes = (t.bytes || 0) + Buffer.byteLength(s);
  try { fs.appendFileSync(logPath(t.id), s); } catch (_) {}
  broadcast({ type: 'task', action: 'output', id: t.id, chunk: s, bytes: t.bytes });
}

function ensureTaskHome() {
  const settings = path.join(TASK_HOME, 'settings.yaml');
  if (!fs.existsSync(settings)) {
    fs.writeFileSync(settings, [
      'ui-theme:',
      '  preference: dark',
      'permission:',
      '  defaultPreset: danger-full-access',
      'llm-deepseek:',
      '  models:',
      '    - id: deepseek-v4-pro',
      '      name: DeepSeek-V4-Pro',
      '      contextWindow: 1000000',
      '    - id: deepseek-flash',
      '      name: deepseek-flash',
      'agent-default-model:',
      '  provider: deepseek-official',
      `  model: ${MODEL}`,
      `  reasoningEffort: ${EFFORT}`,
      '',
    ].join('\n'), 'utf8');
  }
}

function apiKey() {
  const env = process.env.DEEPSEEK_API_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const txt = fs.readFileSync(path.join(TASK_HOME, '.credentials.yaml'), 'utf8');
    const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m);
    if (m) return m[1].trim();
  } catch (_) {}
  return '';
}

function pump() {
  while (running < CONCURRENCY) {
    const next = queue.find(t => t.status === 'pending');
    if (!next) return;
    runTask(next).catch(e => log('runTask 崩溃', e && e.message));
  }
}

async function runTask(t) {
  running++;
  t.status = 'running'; t.startedAt = Date.now(); t.pid = null;
  broadcast({ type: 'task', action: 'started', task: taskView(t) });
  log('执行', t.id, t.title);
  save();

  const key = apiKey();
  const childEnv = {
    ...process.env,
    DSH_HOME: TASK_HOME,
    ...(key ? { DEEPSEEK_API_KEY: key } : {}),
  };
  delete childEnv.DSH_PROFILE;
  delete childEnv.DSH_PROFILE_DIR;
  delete childEnv.DSH_SESSION_ID;

  if (!key) {
    appendLog(t, '[警告] 未找到 DEEPSEEK_API_KEY（环境变量或 tasks/home/.credentials.yaml），模型调用会失败。\n');
  }

  // 任务文本走 UTF-8 文件，避免命令行参数的编码问题（中文尤其明显）
  const taskFile = path.join(DIR, 'prompts', t.id + '.txt');
  fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  fs.writeFileSync(taskFile, CONFIRM_POLICY + t.prompt, 'utf8');

  const args = ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', RUNNER_PS1,
    '-TaskFile', taskFile, '-Cwd', t.workdir, '-Profile', PROFILE];
  const child = spawn(PWSH, args, { cwd: t.workdir, env: childEnv, windowsHide: true });
  t.pid = child.pid;
  save();

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    appendLog(t, '\n[超时] 任务超过 ' + Math.round(TIMEOUT_MS / 60000) + ' 分钟，正在终止。\n');
    try { child.kill(); } catch (_) {}
  }, TIMEOUT_MS);

  child.stdout.on('data', d => appendLog(t, d));
  child.stderr.on('data', d => appendLog(t, d));
  child.on('error', e => { appendLog(t, '[启动失败] ' + e.message + '\n'); });

  await new Promise((resolve) => {
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  }).then((code) => {
    t.exitCode = code;
    t.endedAt = Date.now();
    t.status = killed ? 'timeout' : (code === 0 ? 'done' : 'failed');
    if (t.status === 'failed' && !t.error) t.error = 'dsh 退出码 ' + code;
    // 命中「需要用户拍板」的约定 → 转成等待确认状态，把问题回传给手机
    const ask = extractQuestion(readLog(t.id, 0).text);
    if (ask && t.status === 'done') {
      t.status = 'needs_confirm';
      t.pending = ask;
      appendLog(t, '\n[需要确认] 这条任务停下来等你在手机上拍板：\n  ' + ask.question +
        (ask.options ? '\n  ' + ask.options : '') + '\n');
    }
    appendLog(t, '\n--- 任务结束：' + t.status + '（退出码 ' + code + '，用时 ' +
      Math.round((t.endedAt - t.startedAt) / 1000) + ' 秒）---\n');
    save();
    broadcast({ type: 'task', action: 'ended', task: taskView(t) });
    notify('ended', t, { tail: tailOf(t.id, 1200) });
    log('结束', t.id, t.status, 'code=' + code);
  });

  running--;
  pump();
}

function stopTask(id) {
  const t = queue.find(x => x.id === id);
  if (!t) return { ok: false, error: '任务不存在' };
  if (t.status !== 'running' || !t.pid) return { ok: false, error: '任务未在执行' };
  const r = spawn(PWSH, ['-NoProfile', '-Command',
    `$p = Get-CimInstance Win32_Process -Filter "ParentProcessId=${t.pid}" | Select-Object -First 1; ` +
    `if ($p) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
    `Stop-Process -Id ${t.pid} -Force -ErrorAction SilentlyContinue; 'stopped'`], { windowsHide: true });
  r.on('close', () => {
    appendLog(t, '\n[手动终止] 已请求停止任务。\n');
    t.status = 'stopped'; t.endedAt = Date.now(); save();
    broadcast({ type: 'task', action: 'ended', task: taskView(t) });
    notify('ended', t, { tail: tailOf(t.id, 800) });
  });
  return { ok: true };
}

/* --------------------------------- HTTP --------------------------------- */

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function body(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > (limit || 200000)) { reject(new Error('too large')); req.destroy(); return; } chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    const key = req.headers['sec-websocket-key'];
    if (!key) { res.writeHead(400); res.end(); return; }
    req.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + WS_GUID).digest('base64') + '\r\n\r\n');
    const sock = req.socket;
    clients.add(sock);
    sock.write(wsFrame(JSON.stringify({ type: 'init', tasks: queue.slice(-50).map(taskView) })));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) === 0x80;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        let payload = buf.slice(off + (masked ? 4 : 0), need);
        if (masked) { const mask = buf.slice(off, off + 4); const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4]; payload = out; }
        buf = buf.slice(need);
        if (op === 0x8) { sock.end(); return; }
        if (op !== 0x1) continue;
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.type === 'watch') {
            const t = queue.find(x => x.id === msg.id);
            if (t) { const l = readLog(t.id, 0); sock.write(wsFrame(JSON.stringify({ type: 'task', action: 'snapshot', id: t.id, text: l.text, task: taskView(t) }))); }
          }
        } catch (_) {}
      }
    });
    const drop = () => { clients.delete(sock); try { sock.destroy(); } catch (_) {} };
    sock.on('close', drop); sock.on('error', drop);
    return;
  }

  try {
    if (p === '/health') return json(res, 200, { ok: true, running, pending: queue.filter(t => t.status === 'pending').length });

    if (p === '/api/info') {
      const k = apiKey();
      return json(res, 200, {
        ok: true, workdir: WORKDIR, model: MODEL, effort: EFFORT, profile: PROFILE,
        concurrency: CONCURRENCY, timeoutMin: Math.round(TIMEOUT_MS / 60000),
        taskHome: TASK_HOME, hasKey: !!k, keyHint: k ? k.slice(0, 6) + '…' + k.slice(-4) : '',
        counts: queue.reduce((acc, t) => (acc[t.status] = (acc[t.status] || 0) + 1, acc), {}),
      });
    }

    if (p === '/api/tasks' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      return json(res, 200, { ok: true, tasks: queue.slice(-limit).reverse().map(taskView) });
    }

    if (p === '/api/task' && req.method === 'POST') {
      const b = JSON.parse((await body(req)) || '{}');
      const t = enqueue(b);
      return json(res, 200, { ok: true, task: taskView(t) });
    }

    // 等待用户拍板的任务（手机端 dsh 用它拿到问题去问用户）
    if (p === '/api/pending' && req.method === 'GET') {
      const items = queue.filter(t => t.status === 'needs_confirm' && !t.pendingResolved).map(taskView);
      return json(res, 200, { ok: true, pending: items });
    }

    // 用户答复了某条确认 → 标记已答复（后续会用带上下文的任务继续）
    if (p === '/api/task/resolve' && req.method === 'POST') {
      const b = JSON.parse((await body(req)) || '{}');
      const t = queue.find(x => x.id === String(b.id || ''));
      if (!t) return json(res, 404, { ok: false, error: '任务不存在' });
      t.pendingResolved = true;
      t.status = 'confirmed';
      t.answer = String(b.answer || '');
      t.endedAt = t.endedAt || Date.now();
      save();
      broadcast({ type: 'task', action: 'ended', task: taskView(t) });
      appendLog(t, '\n[已答复] 用户答复：' + t.answer + '\n');
      log('确认已答复', t.id, t.answer.slice(0, 60));
      return json(res, 200, { ok: true, task: taskView(t) });
    }

    if (p === '/api/task/log') {
      const id = url.searchParams.get('id');
      const from = parseInt(url.searchParams.get('from') || '0', 10);
      const t = queue.find(x => x.id === id);
      if (!t) return json(res, 404, { ok: false, error: '任务不存在' });
      const l = readLog(id, from);
      return json(res, 200, { ok: true, text: l.text, size: l.size, task: taskView(t) });
    }

    if (p === '/api/task/stop' && req.method === 'POST') {
      const b = JSON.parse((await body(req)) || '{}');
      return json(res, 200, stopTask(String(b.id || '')));
    }

    if (p === '/api/task/delete' && req.method === 'POST') {
      const b = JSON.parse((await body(req)) || '{}');
      const id = String(b.id || '');
      const idx = queue.findIndex(x => x.id === id);
      if (idx < 0) return json(res, 404, { ok: false, error: '任务不存在' });
      if (queue[idx].status === 'running') return json(res, 400, { ok: false, error: '任务执行中，先停止' });
      queue.splice(idx, 1);
      try { fs.unlinkSync(logPath(id)); } catch (_) {}
      save();
      broadcast({ type: 'task', action: 'deleted', id });
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e && e.message) });
  }
});

server.listen(PORT, HOST, () => {
  load();
  ensureTaskHome();
  log('==================== dsh 任务分发服务 ====================');
  log('监听: http://' + HOST + ':' + PORT + '   （由 agent 转发给手机）');
  log('任务工作目录: ' + WORKDIR);
  log('任务 DSH_HOME: ' + TASK_HOME + '   模型: ' + MODEL + '/' + EFFORT);
  log('并发: ' + CONCURRENCY + '   单任务超时: ' + Math.round(TIMEOUT_MS / 60000) + ' 分钟');
  log('API Key: ' + (apiKey() ? '已就绪' : '缺失（请设置 DEEPSEEK_API_KEY 或写入 tasks/home/.credentials.yaml）'));
  log('待恢复任务: ' + queue.filter(t => t.status === 'pending').length + ' 个');
  log('========================================================');
  pump();
});

process.on('uncaughtException', e => log('uncaught', (e && e.stack) || String(e)));
process.on('unhandledRejection', e => log('unhandled', String(e)));
