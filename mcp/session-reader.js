/*
 * dsh 会话读取器：把电脑上的会话文件解析成「人类可读的进度」
 *
 * 会话存储：<DSH_HOME>/sessions/<工作目录slug>/<session-xxx>/session[.v4].jsonl.zstd
 *   —— 文件是**多帧 zstd 追加**写入的：一次 zstdDecompressSync 只能解出第一帧，
 *      所以要按 engine.bytesWritten 逐帧往前推。
 *
 * 关键事件（seq 递增）：
 *   session            会话头（id / createdAt / cwd / agentPreset）
 *   session/title      标题
 *   user/message       data.content[]{type:text} / data.source.kind
 *   assistant/message  data.message.content[]{text|reasoning|tool-call}
 *   tool/call          data.name / data.arguments
 *   tool/result        data.message.content[]{text}
 *   todo/write         data.todos[]{content,status}   ← 判断「进行到哪」最有用
 *   turn/start|turn/end(turn, reason)  step/start|step/end
 *   deliverables/presented  data.files[]{path,description}
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

/** 逐帧解压多帧 zstd（dsh 会话是追加写的） */
function decompressAll(buf) {
  const parts = [];
  let off = 0, frames = 0;
  while (off < buf.length) {
    let res;
    try { res = zlib.zstdDecompressSync(buf.subarray(off), { info: true }); } catch (_) { break; }
    parts.push(res.buffer);
    frames++;
    const used = (res.engine && res.engine.bytesWritten) || 0;
    if (!used) break;
    off += used;
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames, consumed: off, total: buf.length };
}

/** 找会话文件（同目录下 v4 与旧版可能并存，取较新的） */
function sessionFile(dir) {
  const cands = ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']
    .map(n => path.join(dir, n)).filter(f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
  if (!cands.length) return null;
  cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return cands[0];
}

const cache = new Map(); // file -> { mtimeMs, size, events }

function loadEvents(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.events;
  const { text } = decompressAll(fs.readFileSync(file));
  const events = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch (_) {}
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, events });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return events;
}

function textOf(content) {
  if (!content) return '';
  const arr = Array.isArray(content) ? content : [content];
  return arr.filter(p => p && p.type === 'text' && p.text).map(p => p.text).join('\n');
}

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+$/g, '');
  return s.length <= n ? s : s.slice(0, n) + `…（截断，共 ${s.length} 字）`;
}

/** 把事件流汇总成进度视图 */
function summarize(events, file) {
  const out = {
    id: '', title: '', cwd: '', agentPreset: '',
    createdAt: 0, lastAt: 0, turns: 0, steps: 0, totalSteps: 0,
    userMsgs: 0, assistantMsgs: 0, toolCalls: 0,
    running: false, lastTurn: 0, lastTurnEnded: false,
    todos: [], lastUser: '', lastAssistant: '', lastTool: '', lastToolResult: '',
    deliverables: [], waitingConfirm: false,
  };
  let lastTodoSeq = -1;
  for (const e of events) {
    const t = e.type || '';
    const seq = typeof e.seq === 'number' ? e.seq : -1;
    if (e.time) out.lastAt = Math.max(out.lastAt, e.time);
    switch (t) {
      case 'session':
        out.id = e.id || ''; out.cwd = e.cwd || ''; out.agentPreset = e.agentPreset || '';
        out.createdAt = e.createdAt || 0; break;
      case 'session/title':
        if (e.data && e.data.title) out.title = e.data.title; break;
      case 'user/message':
        out.userMsgs++;
        out.lastUser = clip(textOf(e.data && e.data.content), 800); break;
      case 'assistant/message': {
        out.assistantMsgs++;
        const c = (e.data && e.data.message && e.data.message.content) || [];
        const txt = textOf(c);
        if (txt.trim()) out.lastAssistant = clip(txt, 1200);
        const tc = c.find(p => p && p.type === 'tool-call');
        if (tc) out.lastTool = tc.name || '';
        // 只看「最后一条」助手消息：远程派活约定里的 NEED_CONFIRM 才算等用户拍板
        out.waitingConfirm = /NEED_CONFIRM\s*[:：]/.test(txt);
        break;
      }
      case 'tool/call':
        out.toolCalls++;
        if (e.data && e.data.name) out.lastTool = e.data.name;
        break;
      case 'tool/result':
        out.lastToolResult = clip(textOf(e.data && e.data.message && e.data.message.content), 400);
        break;
      case 'todo/write':
        if (seq >= lastTodoSeq && e.data && Array.isArray(e.data.todos)) {
          lastTodoSeq = seq;
          out.todos = e.data.todos.map(x => ({ content: String(x.content || ''), status: String(x.status || '') }));
        }
        break;
      case 'deliverables/presented':
        if (e.data && Array.isArray(e.data.files)) {
          for (const f of e.data.files) out.deliverables.push({ path: f.path, description: f.description || '' });
        }
        break;
      case 'turn/start':
        out.turns = Math.max(out.turns, (e.data && e.data.turn) || 0);
        out.running = true; out.lastTurnEnded = false;
        break;
      case 'turn/end':
        out.lastTurn = Math.max(out.lastTurn, (e.data && e.data.turn) || 0);
        out.running = false; out.lastTurnEnded = true;
        out.lastReason = (e.data && e.data.reason && e.data.reason.kind) || '';
        break;
      case 'step/end':
        out.totalSteps++;
        out.steps = (e.data && e.data.step) || 0;   // 最后一步的序号
        break;
      default: break;
    }
  }
  out.turns = out.turns || out.lastTurn;
  try {
    const st = fs.statSync(file);
    out.file = file; out.sizeKB = Math.round(st.size / 1024); out.mtime = st.mtimeMs;
  } catch (_) {}
  return out;
}

/** 列出所有会话（按最后活动倒序） */
function listSessions(roots, limit) {
  const rows = [];
  for (const root of roots) {
    let works = [];
    try { works = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const w of works) {
      if (!w.isDirectory()) continue;
      const wdir = path.join(root, w.name);
      let subs = [];
      try { subs = fs.readdirSync(wdir, { withFileTypes: true }); } catch (_) { continue; }
      for (const s of subs) {
        const sdir = path.join(wdir, s.name);
        let f = null;
        if (s.isDirectory()) f = sessionFile(sdir);
        else if (s.name.endsWith('.zstd') || s.name.endsWith('.jsonl')) f = sdir; // 兼容少数布局
        if (!f) continue;
        let st; try { st = fs.statSync(f); } catch (_) { continue; }
        rows.push({ file: f, root, workdir: w.name, dir: sdir, mtime: st.mtimeMs, sizeKB: Math.round(st.size / 1024) });
      }
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit || 20).map(r => {
    let sum = null;
    try { sum = summarize(loadEvents(r.file), r.file); } catch (_) {}
    return Object.assign({}, r, {
      id: (sum && sum.id) || path.basename(r.dir),
      title: (sum && sum.title) || '',
      cwd: (sum && sum.cwd) || '',
      running: !!(sum && sum.running),
      waitingConfirm: !!(sum && sum.waitingConfirm),
      turns: (sum && sum.turns) || 0,
      todos: (sum && sum.todos) || [],
      lastUser: (sum && sum.lastUser) || '',
      lastAt: (sum && sum.lastAt) || r.mtime,
    });
  });
}

function findSession(roots, idOrName) {
  const list = listSessions(roots, 500);
  const q = String(idOrName || '').trim();
  return list.find(s => s.id === q) ||
         list.find(s => s.id === 'session-' + q) ||
         list.find(s => path.basename(s.dir) === q) ||
         list.find(s => s.id.includes(q)) ||
         null;
}

function readSession(roots, idOrName, tailN = 6) {
  const meta = findSession(roots, idOrName);
  if (!meta) return null;
  const events = loadEvents(meta.file);
  const sum = summarize(events, meta.file);
  const tail = [];
  for (const e of events) {
    const t = e.type || '';
    if (t === 'user/message') tail.push({ role: '用户', at: e.time, text: clip(textOf(e.data && e.data.content), 600) });
    else if (t === 'assistant/message') {
      const txt = textOf((e.data && e.data.message && e.data.message.content) || []);
      if (txt.trim()) tail.push({ role: '助手', at: e.time, text: clip(txt, 900) });
      const tc = ((e.data && e.data.message && e.data.message.content) || []).find(p => p && p.type === 'tool-call');
      if (tc) tail.push({ role: '调用', at: e.time, text: tc.name || '' });
    } else if (t === 'tool/result') {
      tail.push({ role: '结果', at: e.time, text: clip(textOf(e.data && e.data.message && e.data.message.content), 300) });
    }
    if (tail.length > tailN * 4) tail.splice(0, tail.length - tailN * 4);
  }
  return { meta, sum, tail: tail.slice(-tailN * 2) };
}

module.exports = { decompressAll, listSessions, readSession, findSession, summarize, loadEvents };
