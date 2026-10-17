// tunnel-supervisor.js —— cloudflared 看护进程
// 背景：这台机器上 cloudflared 会被安全软件周期性杀掉（约 1~2 分钟一次），
//      但 node 进程能长期存活。所以用 node 常驻看守：隧道一退就立刻重启。
// 启动方式：由 stack.ps1 用 WMI 拉起（node 进程脱离父进程，长期存活）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MC  = path.join(__dirname, '..');
const CF  = path.join(os.homedir(), '.dsh', 'dsh-pocket', 'bin', 'cloudflared.exe');
const CFG = path.join(os.homedir(), '.cloudflared', 'config.yml');
const LOG = path.join(MC, 'tunnel-supervisor.log');

function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

if (!fs.existsSync(CF))  { log('缺少 cloudflared: ' + CF); process.exit(1); }
if (!fs.existsSync(CFG)) { log('缺少隧道配置: ' + CFG); process.exit(1); }

let child = null;
let restarts = 0;

function start() {
  // windowsHide: true —— 不弹窗口；即使被隐藏后被杀，看护也会立刻重启
  child = spawn(CF, ['--logfile', path.join(MC, '_cf.log'), '--loglevel', 'info',
                     'tunnel', '--protocol', 'http2', '--config', CFG, 'run'],
                { windowsHide: true, stdio: 'ignore' });
  log(`启动 cloudflared pid=${child.pid}`);
  child.on('exit', (code, sig) => {
    restarts++;
    log(`cloudflared 退出 code=${code} sig=${sig}（累计重启 ${restarts} 次），2 秒后重启`);
    setTimeout(start, 2000);
  });
  child.on('error', (e) => log('spawn 错误: ' + e.message));
}

process.on('SIGINT', () => { if (child) child.kill(); process.exit(0); });
process.on('SIGTERM', () => { if (child) child.kill(); process.exit(0); });

log('看护进程启动');
start();
// 心跳，便于确认看护还活着
setInterval(() => log('心跳 看护存活，重启次数=' + restarts), 5 * 60 * 1000);
