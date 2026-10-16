#!/usr/bin/env node
/*
 * PC 的 MCP 服务（Model Context Protocol, streamable-http, 零第三方依赖）
 *
 * 作用：把「在这台电脑上干活」的能力暴露成标准 MCP 工具。
 *       手机上的 dsh（DSHA）通过 MCP 连接它，就得到这些原生工具：
 *
 *         mcp__pc__run_task      在电脑上派活给 dsh（走本地 dispatcher，异步执行）
 *         mcp__pc__list_tasks    看任务列表与状态
 *         mcp__pc__task_log      看某个任务的输出
 *         mcp__pc__stop_task     停止任务
 *         mcp__pc__run_shell     直接在电脑上执行 PowerShell（同步返回输出）
 *         mcp__pc__system_info   电脑基本信息（系统/CPU/内存/磁盘/网络）
 *         mcp__pc__open_url      在电脑上打开网址（默认浏览器）
 *
 * 协议要点：JSON-RPC 2.0 over HTTP；支持 initialize / tools/list / tools/call / ping，
 *          响应以 application/json 返回（MCP streamable-http 允许）。
 * 安全：需 Authorization: Bearer <token>（或 ?t=<token>），只监听局域网/回环。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const sessionReader = require('./session-reader.js');

// 能读到哪些会话：桌面 dsh 的 home + 远程派活的 home（可用环境变量覆盖）
const SESSION_ROOTS = (process.env.MC_SESSION_ROOTS || '')
  .split(';').map(s => s.trim()).filter(Boolean)
  .concat([
    path.join(os.homedir(), '.dsh', 'sessions'),
    path.resolve(__dirname, '..', 'dsh-home', 'sessions'),
  ]);

const PORT = parseInt(process.env.MC_MCP_PORT || '19395', 10);
const HOST = process.env.MC_MCP_HOST || '0.0.0.0';
const ROOT = path.dirname(__dirname);
const TOKEN = (process.env.MC_MCP_TOKEN || '').trim() || (() => {
  try { return fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim(); } catch (_) { return 'changeme'; }
})();
const DISPATCH = process.env.MC_DISPATCH_URL || 'http://127.0.0.1:19392';
const LOG_FILE = path.join(__dirname, 'mcp.log');

function log(...a) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' +
    a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

/* --------------------------------- 工具实现 -------------------------------- */

function httpJson(urlString, method, body, headers) {
  return new Promise((resolve) => {
    const url = new URL(urlString);
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, method,
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, text: '' }));
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.end(data || undefined);
  });
}

function runPS(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command',
      '$ErrorActionPreference="Continue"; [Console]::OutputEncoding=[Text.Encoding]::UTF8;' + command];
    const child = execFile('powershell.exe', args, {
      cwd: cwd || path.resolve(ROOT, '..'), windowsHide: true, timeout: timeoutMs || 120000, maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: stdout || '', stderr: stderr || '',
        killed: !!(err && err.killed),
      });
    });
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e && e.message) }));
  });
}

/** 通过转发端口(19391)调用电脑侧 dsh 的 RPC（cookie 由转发层自动附加） */
async function relayRpc(body) {
  const b = Buffer.from(JSON.stringify(body), 'utf8');
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 19391, path: '/api/' + body.method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': b.length, Host: '127.0.0.1:19391' } }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {} resolve(j); });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end(b);
  });
}

/** 读电脑自己的工作区索引：工作区顺序、标题、每个工作区的会话顺序、以及"已归档"名单 */
function readWorkspaceIndex() {
  const cands = [
    path.join(os.homedir(), '.dsh', 'storages', 'workspace.json'),
    path.join(ROOT, 'dsh-web-desktop', 'storages', 'workspace.json'),
  ];
  for (const p of cands) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const archived = new Set((j.global && j.global.archivedSessionIds) || []);
      const order = (j.global && j.global.workspaceIds) || [];
      const table = (j.tables && j.tables.workspaces) || {};
      const list = [];
      const push = (id) => {
        const w = table[id];
        if (!w) return;
        list.push({ id, title: w.title || '', path: w.path || '', sessionIds: w.sessionIds || [] });
      };
      order.forEach(push);
      Object.keys(table).forEach(id => { if (!order.includes(id)) push(id); });
      if (list.length) return { workspaces: list, archived };
    } catch (e) { /* 换下一个候选 */ }
  }
  return null;
}

const TOOLS = [
  {
    name: 'run_task',
    description: '在电脑上给 dsh 派一个任务（异步执行，立刻返回任务 id；稍后用 task_log 取结果）。适合：改代码、跑测试、整理文件、查资料等需要电脑上 dsh 动手的活。如果电脑上的任务返回「需要确认」（状态 needs_confirm），请先用你自己的提问工具问用户，然后带上用户的答复用本工具重新派活（把答复放进 context）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '任务内容，用自然语言描述要电脑做什么' },
        context: { type: 'string', description: '可选：补充上下文，会附在任务后面。常用于「用户对上一次确认的答复」' },
        workdir: { type: 'string', description: '可选：任务的工作目录（默认 E:\\harness-workspace）' },
        title: { type: 'string', description: '可选：任务标题，便于在列表里辨认' },
        sessionId: { type: 'string', description: '可选：这个活是从哪条会话派出去的（App 会把确认弹在那条会话里）' },
        focus: { type: 'boolean', description: '可选：新建后是否把电脑 dsh 界面切到这条新会话（默认是）' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'pending_confirmations',
    description: '查看电脑上「等用户拍板」的任务：它们干到一半停下来，把问题交给你，由你转达给用户选。拿到问题后：用你的 ask_user_question 让用户选，然后调用 answer_confirmation 把答复发回去继续。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'answer_confirmation',
    description: '把用户对某条「待确认任务」的答复发回电脑，电脑会自动带着这个答复把原任务继续做完。调用前请先用 ask_user_question 问过用户。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待确认任务的 id（从 pending_confirmations 或 task_log 得到）' },
        answer: { type: 'string', description: '用户的选择/答复原文' },
      },
      required: ['id', 'answer'],
    },
  },
  {
    name: 'sessions',
    description: '列出电脑上 dsh 的会话（含正在进行的）：标题、工作目录、轮次、待办完成情况、最后活动时间、是否在跑、是否等你确认。想知道「电脑上那个任务到哪了」，先看这里再配合 session_progress。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 10' },
        only_active: { type: 'boolean', description: '可选：只看还在跑的/等你确认的会话' },
      },
    },
  },
  {
    name: 'session_progress',
    description: '读取电脑上某个会话的详细进度：状态、轮次/步数、待办清单（哪几项完成、哪项在做）、产出文件、最近几轮对话与工具调用。适合人已经出门、想知道任务做到哪一步了。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '会话 id（可从 sessions 工具拿到）' },
        tail: { type: 'number', description: '可选：返回最近多少条对话，默认 6' },
      },
      required: ['id'],
    },
  },
  {
    name: 'session_send',
    description: '往电脑上某个已有会话里发一条消息（等于在电脑上那条会话里打字）：电脑会继续跑这个会话，结果写回同一条会话，用 session_progress 就能看到。适合"接着做"——比如你在外面想接着电脑上没做完的那条会话。默认排队执行（mode=queue）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '会话 id（从 sessions 工具拿到）' },
        text: { type: 'string', description: '要发进这条会话的消息内容' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: '可选：queue（默认，排队）/ steer（插话）' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'session_new',
    description: '在电脑上新建一条 dsh 会话（可选直接发出第一条消息）。手机想"另起一件事"时用它，建完返回新会话 id，可继续用 session_progress 追进度、session_send 追话。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '可选：新建后立刻发出的第一条消息' },
        cwd: { type: 'string', description: '可选：工作目录，默认 E:\\harness-workspace' },
      },
      required: [],
    },
  },
  {
    name: 'list_tasks',
    description: '列出电脑上最近的任务及其状态（排队中/执行中/已完成/待你确认/失败）与耗时。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数，默认 8' } },
    },
  },
  {
    name: 'task_log',
    description: '读取某个任务的输出日志（可只取新增部分）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        from: { type: 'number', description: '可选：从第几个字节开始取（增量读取）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'stop_task',
    description: '停止电脑上正在执行的任务。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '任务 id' } }, required: ['id'] },
  },
  {
    name: 'run_shell',
    description: '直接在电脑上执行一条 PowerShell 命令并同步返回输出。适合快速查询（看进程、看文件、看网络、开关应用等）。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell 命令' },
        cwd: { type: 'string', description: '可选：工作目录' },
        timeout_s: { type: 'number', description: '可选：超时秒数，默认 120' },
      },
      required: ['command'],
    },
  },
  {
    name: 'system_info',
    description: '获取电脑的基本信息：系统版本、CPU、内存、磁盘、网络接口、当前开机时长。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_url',
    description: '在电脑上用默认浏览器打开一个网址。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要打开的网址' } }, required: ['url'] },
  },
];

const SYSTEM_INFO_PS = [
  '$os = Get-CimInstance Win32_OperatingSystem',
  '$cs = Get-CimInstance Win32_ComputerSystem',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
  '"电脑:     $($cs.Name)"',
  '"系统:     $($os.Caption) $($os.Version)"',
  '"CPU:      $($cpu.Name) ($($cpu.NumberOfCores) 核)"',
  '"内存:     $([math]::Round($cs.TotalPhysicalMemory/1GB,1)) GB / 可用 $([math]::Round($os.FreePhysicalMemory/1MB,1)) GB"',
  '"开机时长: $([math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1)) 小时"',
  '"磁盘:"',
  'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "  $($_.DeviceID) 可用 $([math]::Round($_.FreeSpace/1GB,1)) GB / 共 $([math]::Round($_.Size/1GB,1)) GB" }',
  '"网络:"',
  'Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | ForEach-Object { "  $($_.IPAddress)  [$($_.InterfaceAlias)]" }',
].join("\n");

async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'run_task': {
      if (!args.prompt) throw new Error('prompt 不能为空');
      const r = await httpJson(DISPATCH + '/api/task', 'POST', {
        prompt: String(args.prompt), context: args.context, workdir: args.workdir, title: args.title,
      });
      if (!r.json || !r.json.ok) throw new Error('派活失败: ' + (r.text || r.error || '未知错误'));
      const t = r.json.task;
      if (args.sessionId) {
        // 记下这个活属于哪条会话，App 才能把确认弹在对应会话里
        try {
          const mp = path.join(__dirname, '..', 'tasks', 'session-map.json');
          const map = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : {};
          map[t.id] = String(args.sessionId);
          fs.writeFileSync(mp, JSON.stringify(map, null, 2));
        } catch (_) {}
      }
      return `已在电脑上派活\n任务 id: ${t.id}\n标题: ${t.title}\n目录: ${t.workdir}\n状态: ${t.status}\n\n用 task_log(id="${t.id}") 取输出。`;
    }
    case 'pending_confirmations': {
      const r = await httpJson(DISPATCH + '/api/pending', 'GET');
      if (!r.json || !r.json.ok) throw new Error('取确认队列失败: ' + (r.text || r.error || ''));
      if (!r.json.pending.length) return '电脑上没有等你拍板的任务。';
      return r.json.pending.map(t =>
        `任务 ${t.id}（${t.title}）等你拍板：\n  问题: ${t.pendingQuestion}\n${t.pendingOptions ? '  ' + t.pendingOptions + '\n' : ''}  原任务: ${t.prompt}\n  → 用 ask_user_question 让用户选，然后用 answer_confirmation(id="${t.id}", answer="用户的答复") 发回去。`
      ).join('\n\n');
    }
    case 'confirmations': {
      const r = await httpJson(DISPATCH + '/api/pending', 'GET');
      if (!r.json || !r.json.ok) throw new Error('取确认队列失败: ' + (r.text || r.error || ''));
      const pend = r.json.pending || [];
      if (!pend.length) return 'NONE';
      return 'CONFIRM|' + pend.map(t => {
        const q = String(t.pendingQuestion || '').replace(/[|\n\r]/g, ' ').trim();
        const opts = String(t.pendingOptions || '').split('|').map(s => s.trim()).filter(Boolean).join('~');
        const title = String(t.title || '').replace(/[|\n\r]/g, ' ').trim();
        let sid = '';
        try {
          const mp = path.join(__dirname, '..', 'tasks', 'session-map.json');
          if (fs.existsSync(mp)) sid = JSON.parse(fs.readFileSync(mp, 'utf8'))[t.id] || '';
        } catch (_) {}
        return [t.id, sid, title, q, opts].join('|');
      }).join('\nCONFIRM|');
    }
    case 'answer_confirmation': {
      if (!args.id || !args.answer) throw new Error('id 与 answer 都不能为空');
      const p = await httpJson(DISPATCH + '/api/pending', 'GET');
      if (!p.json || !p.json.ok) throw new Error('取确认队列失败: ' + (p.text || ''));
      const item = (p.json.pending || []).find(t => t.id === args.id);
      if (!item) throw new Error('没找到待确认任务 ' + args.id + '（可能已经答复过了）');
      // 1) 标记已答复
      const rs = await httpJson(DISPATCH + '/api/task/resolve', 'POST', { id: args.id, answer: String(args.answer) });
      if (!rs.json || !rs.json.ok) throw new Error('标记答复失败: ' + (rs.text || ''));
      // 2) 带着答复把原任务继续做完
      const r2 = await httpJson(DISPATCH + '/api/task', 'POST', {
        prompt: item.prompt,
        context: '用户对上一次确认的答复：' + String(args.answer),
        workdir: item.workdir,
        title: item.title + '（已确认后继续）',
      });
      if (!r2.json || !r2.json.ok) throw new Error('继续任务失败: ' + (r2.text || ''));
      return `已把答复发给电脑，原任务继续执行。\n用户答复: ${args.answer}\n新任务 id: ${r2.json.task.id}（${r2.json.task.title}）\n状态: ${r2.json.task.status}\n\n稍后用 task_log(id="${r2.json.task.id}") 取结果。`;
    }
    case 'sessions': {
      const limit = Math.max(1, Math.min(80, parseInt(args.limit || 40, 10)));
      const all = sessionReader.listSessions(SESSION_ROOTS, 200);
      if (!all.length) return '电脑上没有会话。';
      const byId = new Map(all.map(s => [s.id, s]));
      const ago = (t) => {
        const s = Math.round((Date.now() - t) / 1000);
        if (s < 60) return s + ' 秒前';
        if (s < 3600) return Math.round(s / 60) + ' 分钟前';
        if (s < 86400) return Math.round(s / 3600) + ' 小时前';
        return Math.round(s / 86400) + ' 天前';
      };
      const line = (s) => {
        const flag = s.waitingConfirm ? '⚠️等你确认' : (s.running ? '🔄进行中' : '✅已结束');
        const todo = s.todos && s.todos.length ? `  待办 ${s.todos.filter(x => x.status === 'completed').length}/${s.todos.length}` : '';
        const doing = s.todos ? s.todos.find(x => x.status === 'in_progress') : null;
        return `- [${flag}] ${s.title || '(无标题)'}  (${s.id})\n   目录 ${s.cwd || s.workdir}${todo}   最后活动 ${ago(s.lastAt)}   轮次 ${s.turns || 0}`
          + (doing ? `\n   正在做: ${doing.content}` : '')
          + (s.lastUser ? `\n   最后一条用户消息: ${String(s.lastUser).replace(/\s+/g, ' ').slice(0, 100)}` : '');
      };
      const idx = readWorkspaceIndex();
      if (!idx) {   // 拿不到索引就退回原来的平铺
        let rows = all.slice(0, limit);
        if (args.only_active) rows = rows.filter(s => s.running || s.waitingConfirm);
        if (!rows.length) return '电脑上没有符合条件的会话。';
        return '电脑上的会话（按最后活动倒序）：\n' + rows.map(line).join('\n');
      }
      const out = [];
      let shown = 0;
      const seen = new Set();
      for (const w of idx.workspaces) {
        const ids = w.sessionIds.filter(id => !idx.archived.has(id) && byId.has(id));
        if (!ids.length) continue;
        if (shown >= limit) break;
        out.push(`== 工作区: ${w.title || w.path} | ${w.path} | ${ids.length} 条 ==`);
        for (const id of ids) {
          if (shown >= limit) break;
          out.push(line(byId.get(id)));
          seen.add(id);
          shown++;
        }
      }
      // 注意：不属于任何工作区、也没归档的"野生会话"不列出来 —— 电脑左侧栏也不显示它们。
      // 需要排查时用 sessions 的 include_orphans:true。
      if (args.include_orphans) {
        const rest = all.filter(s => !seen.has(s.id) && !idx.archived.has(s.id));
        if (rest.length) {
          out.push(`== 工作区: 其他 | (不属任何工作区) | ${rest.length} 条 ==`);
          rest.forEach(s => out.push(line(s)));
        }
      }
      if (!out.length) return '电脑上没有符合条件的会话。';
      return '电脑上的会话（与左侧栏一致：按工作区分组，不含已归档）：\n' + out.join('\n');
    }    case 'focus_session': {
      if (!args.sessionId) throw new Error('sessionId 不能为空');
      // 目标会话的标题（用来核对电脑是否真的切过去了）
      const all = sessionReader.listSessions(SESSION_ROOTS, 200);
      const byId = new Map(all.map(s => [s.id, s]));
      const target = byId.get(String(args.sessionId));
      const targetTitle = (target && target.title) ? String(target.title).trim() : '';
      const idx = readWorkspaceIndex();
      let row = 0;
      if (idx) {
        for (const w of idx.workspaces) {
          const ids = w.sessionIds.filter(id => !idx.archived.has(id));
          const pos = ids.indexOf(String(args.sessionId));
          if (pos >= 0) { row = pos + 1; break; }
        }
      }
      if (!row) return '电脑侧栏里没找到这条会话（可能属于已归档或不在工作区）。';
      const script = path.join(__dirname, '..', 'tools', 'focus-session.ps1');
      const runPs = (file, psArgs, ms) => new Promise((resolve) => {
        const ps = require('child_process').spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file].concat(psArgs), { windowsHide: true });
        let buf = '';
        ps.stdout.on('data', d => { buf += d.toString(); });
        ps.on('exit', () => resolve(buf));
        setTimeout(() => resolve(buf + ' (timeout)'), ms || 20000);
      });
      const winTitle = () => new Promise((resolve) => {
        const ps = require('child_process').spawn('powershell.exe',
          ['-NoProfile', '-Command', "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-Process | Where-Object { $_.MainWindowTitle -match 'DeepSeek Harness' } | Select-Object -First 1).MainWindowTitle"],
          { windowsHide: true });
        let buf = '';
        ps.stdout.on('data', d => { buf += d.toString(); });
        ps.on('exit', () => resolve(buf.trim()));
        setTimeout(() => resolve(buf.trim()), 8000);
      });
      const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[—\-–]/g, '');
      // 快路径：电脑已经在这条会话上，就不用点（省得又慢又闪）
      if (targetTitle) {
        const cur = await winTitle();
        if (norm(cur).includes(norm(targetTitle))) return '电脑已经在「' + targetTitle + '」这条会话上了。';
      }
      // 闭环：点一次 → 读电脑窗口标题核对 → 不对就换行号再试（自校正；候选只试 3 个，保证手机不超时）
      const tried = [];
      const candidates = [row, row - 1, row + 1];
      for (const cand of candidates) {
        if (cand < 1 || tried.includes(cand)) continue;
        tried.push(cand);
        const out = await runPs(script, ['-Row', String(cand)], 20000);
        if (out.includes('FAIL')) { if (cand === row) return '切换失败：' + String(out).trim().replace(/\s+/g, ' ').slice(0, 140); continue; }
        await new Promise(r => setTimeout(r, 1500));
        const now = await winTitle();
        const hit = targetTitle ? norm(now).includes(norm(targetTitle)) : false;
        if (hit) return '已让电脑界面切到这条会话（侧栏第 ' + cand + ' 条 · 电脑标题已核对一致）。';
      }
      const now = await winTitle();
      return '点了 ' + tried.length + ' 次都没切过去（电脑当前标题：' + now + '，目标：' + targetTitle + '）。';
    }    case 'session_progress': {
      if (!args.id) throw new Error('id 不能为空');
      const tailN = Math.max(1, Math.min(20, parseInt(args.tail || 6, 10)));
      const d = sessionReader.readSession(SESSION_ROOTS, args.id, tailN);
      if (!d) throw new Error('没找到会话 ' + args.id + '（可用 sessions 工具看有哪些）');
      const s = d.sum;
      const t = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
      const lines = [];
      lines.push(`会话: ${s.title || '(无标题)'}   (${s.id})`);
      lines.push(`目录: ${s.cwd || d.meta.workdir}   预设: ${s.agentPreset || '-'}`);
      lines.push(`状态: ${s.waitingConfirm ? '⚠️ 干到一半在等你拍板' : (s.running ? '🔄 正在进行中' : `✅ 已结束（第 ${s.lastTurn} 轮 ${s.lastReason || 'completed'}）`)}`);
      lines.push(`时间: 创建 ${t(s.createdAt)}   最后活动 ${t(s.lastAt)}`);
      lines.push(`规模: ${s.turns} 轮 / ${s.totalSteps} 步 / 用户消息 ${s.userMsgs} / 助手消息 ${s.assistantMsgs} / 工具调用 ${s.toolCalls}   文件 ${d.meta.sizeKB}KB`);
      if (s.todos.length) {
        lines.push('待办清单:');
        for (const x of s.todos) {
          const mark = x.status === 'completed' ? '✔' : (x.status === 'in_progress' ? '▶' : '·');
          lines.push(`  ${mark} [${x.status}] ${x.content}`);
        }
      }
      if (s.deliverables.length) {
        lines.push('产出文件:');
        for (const f of s.deliverables.slice(-6)) lines.push(`  ${f.path}${f.description ? '  — ' + f.description : ''}`);
      }
      lines.push('最近动作: ' + (s.lastTool ? '最后一个工具是 ' + s.lastTool : '(无)') +
        (s.lastToolResult ? '，结果：' + String(s.lastToolResult).replace(/\s+/g, ' ').slice(0, 160) : ''));
      if (d.tail.length) {
        lines.push('最近对话:');
        for (const x of d.tail) lines.push(`  [${x.role}] ${String(x.text).replace(/\s+/g, ' ').slice(0, 240)}`);
      }
      return lines.join('\n');
    }
    case 'session_send': {
      if (!args.id || !args.text) throw new Error('id 与 text 都不能为空');
      const requestId = 'mc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const body = {
        type: 'client-request',
        rpcId: requestId,
        method: 'session/prompt',
        payload: {
          args: {
            request: {
              requestId,
              sessionId: String(args.id),
              mode: args.mode === 'steer' ? 'steer' : 'queue',
              content: [{ type: 'text', text: String(args.text) }],
              clientTimeZone: 'Asia/Shanghai',
            },
          },
        },
      };
      const b = Buffer.from(JSON.stringify(body), 'utf8');
      const done = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: 19391, path: '/api/session/prompt', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': b.length, Host: '127.0.0.1:19391' } }, (res) => {
          const chunks = [];
          res.on('data', d => chunks.push(d));
          res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {} resolve({ status: res.statusCode, j }); });
        });
        req.on('error', e => resolve({ status: 0, err: e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
        req.end(b);
      });
      if (done.err) throw new Error('发消息失败: ' + done.err + '（检查 19391 转发端口与 dsh 实例是否在跑）');
      if (!done.j || !done.j.result) throw new Error('返回异常: HTTP ' + done.status);
      if (!done.j.result.ok) throw new Error('电脑拒绝了这条消息: ' + JSON.stringify(done.j.result.error));
      return `已发进电脑上的会话 ${args.id}（${done.j.result.value && done.j.result.value.accepted ? '电脑已接受' : '已提交'}）。\n内容: ${String(args.text).slice(0, 120)}\n\n电脑会继续跑这条会话；稍后用 session_progress(id="${args.id}") 看进度。`;
    }
    case 'session_new': {
      // 去重：同样的第一句话在 90 秒内只建一条 —— 客户端超时重试也不会重复建
      const dupKey = String(args.text || '').trim();
      const recentFile = path.join(__dirname, '..', 'tasks', 'session-new-recent.json');
      let recent = {};
      try { if (fs.existsSync(recentFile)) recent = JSON.parse(fs.readFileSync(recentFile, 'utf8')); } catch (_) {}
      const prev = dupKey ? recent[dupKey] : null;
      if (prev && Date.now() - prev.at < 90000) {
        return '这条刚才已经建过了（' + Math.round((Date.now() - prev.at) / 1000) + ' 秒前），直接用它：' + prev.id
             + '\n\n用 session_progress(id="' + prev.id + '") 看进度。';
      }
      const cwd = String(args.cwd || 'E:\\\\harness-workspace');
      // 关键：带上 workspaceId，会话才会被挂到工作区里（否则电脑侧栏和手机列表都不显示它）
      let wsId = null;
      try {
        const idx = readWorkspaceIndex();
        if (idx) {
          const norm = (p) => String(p || "").replace(/[\\\\/]+$/, "").toLowerCase();
          const w = idx.workspaces.find(x => norm(x.path) === norm(cwd)) || idx.workspaces[0];
          if (w) wsId = w.id;
        }
      } catch (_) {}
      const reqObj = wsId ? { workspaceId: wsId } : { cwd };   // 接口要求：两者只能给一个
      const body = { type: 'client-request', rpcId: 'mc-new-' + Date.now().toString(36), method: 'session/create', payload: { args: { request: reqObj } } };
      const res = await relayRpc(body);
      if (!res || !res.result || !res.result.ok) throw new Error('新建失败: ' + JSON.stringify(res && res.result && res.result.error || res));
      const id = res.result.value && res.result.value.sessionId;
      let extra = '';
      if (args.text && id) {
        const requestId = 'mc-' + Date.now().toString(36) + '-1';
        const p2 = { type: 'client-request', rpcId: requestId, method: 'session/prompt', payload: { args: { request: {
          requestId, sessionId: id, mode: 'queue',
          content: [{ type: 'text', text: String(args.text) }], clientTimeZone: 'Asia/Shanghai' } } } };
        const r2 = await relayRpc(p2);
        extra = (r2 && r2.result && r2.result.ok) ? '\n第一条消息已发出，电脑开始跑了。' : '\n（第一条消息没发出去：' + JSON.stringify(r2 && r2.result && r2.result.error) + '）';
      } else if (args.text) { extra = '\n（没拿到会话 id，消息未发）'; }
      // 记下这次的内容，供 90 秒去重用
      if (dupKey) {
        try {
          recent[dupKey] = { id, at: Date.now() };
          const keys = Object.keys(recent).sort((a, b) => recent[b].at - recent[a].at).slice(0, 20);
          const trimmed = {};
          keys.forEach(k => { trimmed[k] = recent[k]; });
          fs.writeFileSync(recentFile, JSON.stringify(trimmed, null, 2));
        } catch (_) {}
      }
      // 把电脑 dsh 的界面切到这条新会话：后台跑，不等待（等了会让手机超时 → 手机重试 → 重复建会话）
      if (args.focus !== false) {
        try {
          const ch = require('child_process').spawn('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
             path.join(__dirname, '..', 'tools', 'focus-session.ps1'), '-Row', '1'],
            { windowsHide: true, detached: true, stdio: 'ignore' });
          ch.unref();
        } catch (_) {}
      }
      const focusMsg = (args.focus === false) ? '' : '\n（电脑界面正在后台切到这条新会话）';
      return '已在电脑上新建会话（目录 ' + cwd + '）：' + id + extra + focusMsg + '\n\n用 session_progress(id="' + id + '") 看进度。';
    }
    case 'list_tasks': {
      const limit = Math.max(1, Math.min(50, parseInt(args.limit || 8, 10)));
      const r = await httpJson(`${DISPATCH}/api/tasks?limit=${limit}`, 'GET');
      if (!r.json || !r.json.ok) throw new Error('取列表失败: ' + (r.text || r.error || ''));
      if (!r.json.tasks.length) return '电脑上还没有任务。';
      const zh = { pending: '排队中', running: '执行中', done: '已完成', needs_confirm: '⚠️待你确认', failed: '失败', stopped: '已停止', timeout: '超时' };
      return '电脑上最近的任务：\n' + r.json.tasks.map(t =>
        `- [${zh[t.status] || t.status}] ${t.title} (${t.id})  用时 ${t.elapsed}s${t.exitCode !== null && t.exitCode !== undefined ? '  退出码 ' + t.exitCode : ''}` +
        (t.pendingQuestion ? `\n    待确认: ${t.pendingQuestion}` : '')
      ).join('\n');
    }
    case 'task_log': {
      if (!args.id) throw new Error('id 不能为空');
      const from = parseInt(args.from || 0, 10);
      const r = await httpJson(`${DISPATCH}/api/task/log?id=${encodeURIComponent(args.id)}&from=${from}`, 'GET');
      if (!r.json || !r.json.ok) throw new Error('取日志失败: ' + (r.text || r.error || ''));
      const t = r.json.task;
      const head = `任务 ${args.id}（${t.status}，累计 ${r.json.size} 字节，本次从 ${from} 开始）\n`;
      let hint = '';
      if (t.status === 'needs_confirm') {
        hint = `\n⚠️ 这条任务停下来等用户拍板，别自己替他决定：\n  问题: ${t.pendingQuestion}\n` +
          (t.pendingOptions ? `  ${t.pendingOptions}\n` : '') +
          `  下一步：用你的提问工具（ask_user_question）把问题和选项呈现给用户，` +
          `拿到答复后调用 run_task：prompt 用原任务文本，context 写「用户对上一次确认的答复：<答复>」。\n`;
      } else if (t.status === 'running' || t.status === 'pending') {
        hint = '\n（任务还在跑，稍后再取一次日志）\n';
      }
      return head + (r.json.text || '(暂无输出)') + hint;
    }
    case 'stop_task': {
      const r = await httpJson(DISPATCH + '/api/task/stop', 'POST', { id: args.id });
      return r.json && r.json.ok ? `已请求停止 ${args.id}` : '停止失败: ' + (r.text || r.error || '');
    }
    case 'run_shell': {
      if (!args.command) throw new Error('command 不能为空');
      const timeoutMs = Math.max(1000, Math.min(600000, (parseInt(args.timeout_s || 120, 10)) * 1000));
      const r = await runPS(String(args.command), args.cwd, timeoutMs);
      const out = [];
      out.push(`退出码: ${r.code}${r.killed ? '（超时被终止）' : ''}`);
      if (r.stdout && r.stdout.trim()) out.push('\n[stdout]\n' + r.stdout.trim());
      if (r.stderr && r.stderr.trim()) out.push('\n[stderr]\n' + r.stderr.trim());
      if (!r.stdout.trim() && !r.stderr.trim()) out.push('(无输出)');
      return out.join('\n');
    }
    case 'system_info': {
      const r = await runPS(SYSTEM_INFO_PS, undefined, 60000);
      return (r.stdout || '').trim() || ('取值失败: ' + r.stderr);
    }
    case 'open_url': {
      if (!args.url) throw new Error('url 不能为空');
      const u = String(args.url);
      if (!/^https?:\/\//i.test(u)) throw new Error('只支持 http/https 网址');
      await runPS(`Start-Process '${u.replace(/'/g, "''")}'`, undefined, 20000);
      return '已在电脑上打开: ' + u;
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

/* ---------------------------------- MCP ---------------------------------- */

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleMessage(msg) {
  const { id, method, params } = msg || {};
  if (method === undefined) return null;
  // 通知（无 id）不回复
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pc-control', version: '1.0.0' },
          instructions: [
            '这台服务把「电脑」的能力暴露成工具：run_task 派活给电脑上的 dsh（异步）、list_tasks/task_log/stop_task 跟踪任务、pending_confirmations 取「等用户拍板」的问题、run_shell 直接执行 PowerShell、system_info 看机器状态、open_url 打开网页。',
            '',
            '【需要用户拍板的事怎么处理】电脑上的任务是无人值守执行的。如果任务返回的状态是 needs_confirm（或用 pending_confirmations 看到有待确认项），',
            '说明电脑那边停下来等你转达：请用你自己的提问工具（ask_user_question）把 pendingQuestion 和选项呈现给用户，拿到答复后，',
            '用 run_task 重新派活——prompt 用原任务文本，context 写「用户对上一次确认的答复：<用户的答复>」。不要自己替用户拍板。',
          ].join('\n'),
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const name = params && params.name;
        const text = await callTool(name, params && params.arguments);
        return rpcResult(id, { content: [{ type: 'text', text: String(text) }], isError: false });
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, 'method not found: ' + method);
    }
  } catch (e) {
    if (isNotification) return null;
    if (method === 'tools/call') {
      return rpcResult(id, { content: [{ type: 'text', text: '执行出错: ' + (e && e.message) }], isError: true });
    }
    return rpcError(id, -32000, String(e && e.message));
  }
}

/* --------------------------------- HTTP --------------------------------- */

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > limit) { req.destroy(); reject(new Error('too large')); return; } chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authOk(req, url) {
  const h = req.headers['authorization'] || '';
  const bearer = h.replace(/^Bearer\s+/i, '').trim();
  const q = url.searchParams.get('t') || '';
  const given = bearer || q;
  return given === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const peer = (req.socket && (req.socket.remoteAddress || '')) || '';
  const send = (code, obj, type = 'application/json; charset=utf-8', extra) => {
    const b = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    res.writeHead(code, Object.assign({ 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-store' }, extra || {}));
    res.end(b);
  };

  if (url.pathname === '/health') {
    return send(200, { ok: true, server: 'pc-control', tools: TOOLS.map(t => t.name), dispatch: DISPATCH });
  }

  if (!authOk(req, url)) {
    log('请求被拒(未授权)', req.method, url.pathname, 'peer=' + peer, 'auth=' + (req.headers['authorization'] ? '有' : '无'));
    return send(401, { error: 'unauthorized' });
  }

  if (url.pathname !== '/mcp' && url.pathname !== '/') {
    log('路径不存在', req.method, url.pathname, 'peer=' + peer);
    return send(404, { error: 'not found' });
  }

  if (req.method === 'GET') {
    // streamable-http 规范：客户端可开一条 GET SSE 流接收服务端主动消息。
    // 本服务不主动推送，但把流开着并发心跳，避免客户端探测被判失败。
    log('GET SSE 流已建立 peer=' + peer);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Mcp-Session-Id': (req.headers['mcp-session-id'] || 'pc-control-session'),
    });
    res.write(': pc-control stream open\n\n');
    const hb = setInterval(() => {
      if (res.writableEnded || res.destroyed) { clearInterval(hb); return; }
      try { res.write(': hb ' + Date.now() + '\n\n'); } catch (_) { clearInterval(hb); }
    }, 15000);
    req.on('close', () => { clearInterval(hb); });
    return;
  }
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' }, 'application/json; charset=utf-8', { Allow: 'POST' });

  let parsed;
  try { parsed = JSON.parse(await readBody(req)); } catch (e) { return send(400, rpcError(null, -32700, 'parse error')); }

  const sessionId = req.headers['mcp-session-id'] || 'pc-control-session';
  try {
    if (Array.isArray(parsed)) {
      const out = [];
      for (const m of parsed) { const r = await handleMessage(m); if (r) out.push(r); }
      if (!out.length) { res.writeHead(202, { 'Mcp-Session-Id': sessionId }); return res.end(); }
      return send(200, out, 'application/json; charset=utf-8', { 'Mcp-Session-Id': sessionId });
    }
    log('rpc', parsed && parsed.method, parsed && parsed.method === 'tools/call' ? (parsed.params && parsed.params.name) : '');
    const r = await handleMessage(parsed);
    if (!r) { res.writeHead(202, { 'Mcp-Session-Id': sessionId }); return res.end(); }
    return send(200, r, 'application/json; charset=utf-8', { 'Mcp-Session-Id': sessionId });
  } catch (e) {
    log('rpc 处理异常', e && e.message);
    return send(500, rpcError(parsed && parsed.id, -32603, String(e && e.message)));
  }
});

server.listen(PORT, HOST, () => {
  log('==================== PC MCP 服务 ====================');
  log('监听: http://' + HOST + ':' + PORT + '/mcp');
  log('鉴权: Authorization: Bearer <token>' + (TOKEN === 'changeme' ? '  【注意 token 仍是 changeme】' : ''));
  log('工具: ' + TOOLS.map(t => 'mcp__pc__' + t.name).join(', '));
  log('后端: ' + DISPATCH);
  log('=====================================================');
});

process.on('uncaughtException', e => log('uncaught', (e && e.stack) || String(e)));
process.on('unhandledRejection', e => log('unhandled', String(e)));
