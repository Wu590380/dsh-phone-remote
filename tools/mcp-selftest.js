#!/usr/bin/env node
/*
 * PC MCP 服务自测（模拟 MCP 客户端：initialize → tools/list → tools/call）
 * 用法: node tools/mcp-selftest.js [host] [port]
 */
'use strict';

const http = require('http');
const host = process.argv[2] || '127.0.0.1';
const port = parseInt(process.argv[3] || '19395', 10);
const fs = require('fs');
const path = require('path');
const token = (() => {
  for (const f of ['mcp-token.txt', 'token.txt']) {
    try { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8').trim(); } catch (_) {}
  }
  return '';
})();

let rpcId = 0;
function rpc(method, params, isNotification) {
  return new Promise((resolve) => {
    const payload = { jsonrpc: '2.0', method };
    if (!isNotification) payload.id = ++rpcId;
    if (params !== undefined) payload.params = params;
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host, port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream' },
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.end(data);
  });
}

(async () => {
  console.log('== 0) 未带 token 应被拒 ==');
  await new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    const req = http.request({ host, port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      res.resume(); console.log('  无 token -> HTTP ' + res.statusCode); resolve();
    });
    req.on('error', e => { console.log('  错误 ' + e.message); resolve(); });
    req.end(data);
  });

  console.log('\n== 1) initialize ==');
  let r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } });
  console.log('  HTTP', r.status);
  console.log('  serverInfo:', JSON.stringify(r.json && r.json.result && r.json.result.serverInfo));
  console.log('  protocolVersion:', r.json && r.json.result && r.json.result.protocolVersion);

  await rpc('notifications/initialized', undefined, true);

  console.log('\n== 2) tools/list ==');
  r = await rpc('tools/list', {});
  const tools = (r.json && r.json.result && r.json.result.tools) || [];
  tools.forEach(t => console.log('  · mcp__pc__' + t.name));

  console.log('\n== 3) tools/call system_info ==');
  r = await rpc('tools/call', { name: 'system_info', arguments: {} });
  const txt = r.json && r.json.result && r.json.result.content && r.json.result.content[0] && r.json.result.content[0].text;
  console.log(String(txt).split('\n').map(l => '  ' + l).join('\n'));

  console.log('\n== 4) tools/call run_shell（查电脑上 dsh 进程与面板端口）==');
  r = await rpc('tools/call', { name: 'run_shell', arguments: { command: 'Get-Process node -ErrorAction SilentlyContinue | Select-Object -First 5 Id,ProcessName | Format-Table -AutoSize | Out-String; (Get-NetTCPConnection -State Listen -LocalPort 19390 -ErrorAction SilentlyContinue | Measure-Object).Count' } });
  console.log('  ' + String(r.json.result.content[0].text).replace(/\n/g, '\n  '));

  console.log('\n== 5) tools/call run_task（真的派活给电脑上的 dsh）==');
  r = await rpc('tools/call', { name: 'run_task', arguments: { prompt: '只回答两个字：收到', title: 'MCP自测' } });
  console.log('  ' + String(r.json.result.content[0].text).replace(/\n/g, '\n  '));
  const m = String(r.json.result.content[0].text).match(/任务 id: ([0-9a-f]+)/);
  const id = m && m[1];

  console.log('\n== 6) 轮询 task_log ==');
  for (let i = 0; i < 20 && id; i++) {
    await new Promise(r2 => setTimeout(r2, 3000));
    const rr = await rpc('tools/call', { name: 'task_log', arguments: { id } });
    const t = String(rr.json.result.content[0].text);
    if (/已完成|失败|超时/.test(t)) { console.log('  ' + t.replace(/\n/g, '\n  ')); break; }
    if (i % 3 === 2) console.log('  …仍在执行（' + ((i + 1) * 3) + 's）');
    if (i === 19) console.log('  ' + t.replace(/\n/g, '\n  '));
  }

  console.log('\n== 7) tools/call list_tasks ==');
  r = await rpc('tools/call', { name: 'list_tasks', arguments: { limit: 5 } });
  console.log('  ' + String(r.json.result.content[0].text).replace(/\n/g, '\n  '));
})().catch(e => { console.error('自测异常:', e); process.exit(1); });
