// 会话读取器自测：列出会话 + 读最新会话的进度
const path = require('path');
const r = require('E:/harness-workspace/mobile-control/mcp/session-reader.js');

const ROOTS = [
  path.join(process.env.USERPROFILE, '.dsh', 'sessions'),
  'E:/harness-workspace/mobile-control/dsh-home/sessions',
];
console.log('== 会话列表（按最后活动倒序，前 8 条）==');
const list = r.listSessions(ROOTS, 8);
for (const s of list) {
  const flag = s.waitingConfirm ? '⚠️待确认' : (s.running ? '🔄进行中' : '✅已结束');
  console.log(`  ${flag}  ${s.id}`);
  console.log(`      标题: ${s.title || '(无)'}`);
  console.log(`      目录: ${s.cwd || s.workdir}   轮次: ${s.turns}   最后活动: ${new Date(s.lastAt).toLocaleString('zh-CN')}   ${s.sizeKB}KB`);
  if (s.todos.length) {
    const done = s.todos.filter(t => t.status === 'completed').length;
    console.log(`      待办: ${done}/${s.todos.length} 完成`);
  }
}
const target = list.find(s => s.running) || list[0];
if (target) {
  console.log('\n== 进度详情:', target.id, '==');
  const d = r.readSession(ROOTS, target.id, 4);
  const s = d.sum;
  console.log(`  标题: ${s.title}`);
  console.log(`  状态: ${s.running ? '进行中（最后 turn 还没结束）' : '已结束（lastTurn=' + s.lastTurn + ' ' + (s.lastReason || '') + '）'}`);
  console.log(`  轮次 ${s.turns} / 步数 ${s.steps} / 用户 ${s.userMsgs} / 助手 ${s.assistantMsgs} / 工具 ${s.toolCalls}`);
  console.log(`  等待确认: ${s.waitingConfirm}`);
  if (s.todos.length) { console.log('  待办清单:'); for (const t of s.todos) console.log(`    [${t.status}] ${t.content}`); }
  if (s.deliverables.length) { console.log('  产出文件:'); for (const f of s.deliverables.slice(-4)) console.log(`    ${f.path}`); }
  console.log('  最近对话:');
  for (const t of d.tail.slice(-6)) console.log(`    ${t.role}: ${String(t.text).replace(/\n/g, ' ').slice(0, 140)}`);
}
