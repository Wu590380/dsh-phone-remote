# 手机 DSHA ⇄ 电脑 dsh 桥（MCP）

**效果**：在手机 **DSHA** 应用里（手机上跑的那套 dsh）直接说话，就能让**这台电脑**干活。
**手机可以在任何网络（4G/5G/外地），不需要和电脑同一个 WiFi，地址永久固定。**

手机 dsh 会获得这些原生工具：

| 工具 | 作用 |
| --- | --- |
| `mcp__pc__run_task` | 在电脑上给 dsh 派活（异步，返回任务 id） |
| `mcp__pc__pending_confirmations` | 查看电脑上「等用户拍板」的任务及问题/选项 |
| `mcp__pc__answer_confirmation` | 把用户的答复发回电脑，电脑带着答复把原任务做完 |
| `mcp__pc__sessions` | **列出电脑上的会话**（含正在进行的）：标题、目录、轮次、待办完成情况、最后活动、是否在跑/等你确认 |
| `mcp__pc__session_progress` | **读某个会话的详细进度**：状态、轮次/步数、待办清单、产出文件、最近对话与工具调用 |
| `mcp__pc__session_send` | **往电脑上某条会话里发消息（接着做）**：电脑继续跑那条会话，结果写回同一会话 |
| `mcp__pc__list_tasks` | 看电脑上的任务列表与状态 |
| `mcp__pc__task_log` | 取某个任务的输出（待确认时会附上「去问用户」的提示） |
| `mcp__pc__stop_task` | 停止任务 |
| `mcp__pc__run_shell` | 直接在电脑上执行 PowerShell（同步返回输出） |
| `mcp__pc__system_info` | 电脑系统/CPU/内存/磁盘/网络 |
| `mcp__pc__open_url` | 在电脑上打开网址 |

## 「手机上看电脑的会话/进度、接着做」

人在外面想知道电脑上那个任务做到哪了、甚至接着做，有两条路：

### 1) 让手机的 dsh 报给你 / 替你接着做（推荐，纯原生不用浏览器）

```
你：电脑上我那个任务到哪了？
手机 dsh → mcp__pc__sessions          （列会话：标题/轮次/待办 x/y 完成/最后活动/是否在跑）
        → mcp__pc__session_progress   （详情：待办逐项状态、产出文件、最近工具调用与对话）

你：在电脑那条会话里说：把测试跑一遍，跑完告诉我结果
手机 dsh → mcp__pc__session_send      （往那条会话发消息，电脑接着跑，结果写回同一条会话）
```

`session_send` 走的是电脑侧 UI 同款的 RPC（`POST /api/session/prompt`，0.2.x 的斜杠命名，
args 里是 `{ request: { requestId, sessionId, mode, content:[{type:'text',text}] } }`），
经转发端口(19391) + 自动签发的会话 cookie 发进去。

**实测（2026-10-16）**：往 8 月的一条旧会话发「只回复两个字：收到」→ 电脑在**同一条会话**里回「收到」，
`session_progress` 显示该会话 `🔄 正在进行中`、最后活动时间刷新。

会话文件是 `<DSH_HOME>/sessions/<工作目录>/<session-id>/session.v4.jsonl.zstd`，
**多帧 zstd 追加写**（Node 的 `zstdDecompressSync` 一次只出一帧，要按 `engine.bytesWritten` 逐帧推），
`mcp/session-reader.js` 负责解析；`tools/session-check.js` 可直接在电脑上打印进度。

### 2) 直接把电脑的 dsh 界面搬到手机上（读写都行）——**推荐**

```
https://pc.example.com/?t=<dsh-web-token.txt 里的令牌>
```

手机上看到的就是**桌面 App 自己的界面**：同一份会话列表（含正在跑的那条）、左侧工作区、实时进度。
只需要转发令牌 `t`，dsh 自己的登录 cookie 由转发层**自动签发并附加**，手机不用管。

链路：`pc.example.com → cloudflared → 127.0.0.1:19391（agent 的转发端口）→ 127.0.0.1:19387（桌面 App 的服务）`

agent 在这一层做三件事：
1. 令牌门禁（无 `?t=` → 401；带 `?t=` → 302 种 Cookie）；
2. 重写 Host/Origin 为回环权威，并**注入 CSS**：`[class*="QWLzlG_"]{display:none}` 隐藏思考过程；
   窄屏把左侧栏改成浮层展开，不再挤压对话；
3. **自动签发 dsh 会话 cookie**（见下）并附加到上游请求（HTTP + WebSocket 都是）。

#### 0.2.x 的鉴权与自动签发

0.2.0-rc.2 起，dsh web 用「authority 绑定 + HMAC 签名」的 cookie 鉴权：

- 启动时打印 `http://127.0.0.1:<port>/?token=<启动令牌>`，用它换一次 cookie；
- cookie 名 = `dsh-auth-` + base64url(sha256(authority))
- cookie 值 = `v1.<base64url(JSON{version,authority,issuedAt,expiresAt})>.<base64url(HMAC-SHA256(secret,body))>`
- secret 持久在 `<DSH_HOME>/.credentials.yaml` 的 `client-connection/browser-session.payload.secret`

因为 secret 持久，**这一层可以自己签发**：`tools/mint-dsh-cookie.js`
（`--home <DSH_HOME> --authority 127.0.0.1:19387 [--days 30]`）。
agent 启动时签名一次、每 12 小时续签，所以手机地址永远不用变，也不用携带 dsh 的启动令牌。


## 技能：手机上一句话查进度

装了一个 dsh **技能**（skill）`pc-progress`，放在电脑的 `mobile-control/skills/pc-progress.md`，
手机上问 **「电脑那边怎么样了 / 我那个任务到哪了 / 做完了吗 / 还在跑吗」** 时，
手机的 dsh 会自动加载它，按里面的流程去调 `sessions` + `session_progress`，然后用中文简报回你
（状态 / 待办 x/y / 正在做的那一步 / 最后活动 / 产出文件；等你拍板的会把选项原样列出来让你选）。

**怎么装上去的**（关键点，换手机或重装时照做）：

1. 技能目录用**公共路径** `/sdcard/Documents/dshdata/skills`（adb 可写，以后电脑用 `adb push` 就能加技能，不用碰手机终端）。
   技能文件是**扁平 Markdown + YAML frontmatter**（`name` 必须 kebab-case，`description` 是触发依据）。
2. 在手机 dsh 的 profile 补丁 `/root/.dsh/profiles/web/cordis.patch.yml` 里加：

   ```yaml
   - id: skill-filesystem
     disabled: false            # 手机上这插件默认被禁用了，必须显式打开
     config:
       customSkillDirs:
         - /sdcard/Documents/dshdata/skills
   ```

3. 重启手机 dsh（「启动」页点「重启」）。验证：`--dump-config` 里该条应为 `disabled: false`。

踩过的两个坑：
- **`settings.yaml` 里配 `skill-filesystem.customSkillDirs` 不生效**（配置层不暴露这个插件），必须走 profile 补丁。
- 手机上 `skill-filesystem` **默认是 `disabled: true`**（DSHA 禁用它省资源）；只加 `customSkillDirs` 而不加 `disabled: false` 是白干。

一键脚本：`skills/_install-skills-on-phone.sh`（推到手机后在 DSHA 终端跑 `bash /sdcard/install-skills.sh`，幂等）。

## 排障：手机说「连不上电脑」（所有固定地址都 530）

**症状**：手机上语音/文字都是"连不上"，`mcp.example.com` 等地址返回 **Cloudflare 530**，但电脑上本地服务（19395/19392/3086…）都好好的。

**原因**：命名隧道的**连接**掉了 —— 进程还在，但没注册上 Cloudflare 边缘。本机实测的典型报错：

```
INF precheck: Environment is healthy（DNS/QUIC/TCP/API 全 PASS）
ERR Register tunnel error from server side error="context deadline exceeded" connIndex=0
ERR initial tunnel connection failed error="control stream error: context deadline exceeded"
```

也就是 **QUIC(UDP) 注册超时**。这台机器上有 `utun8`（MTU 65535）和 Radmin VPN 两条虚拟网卡，UDP 路径容易被搞坏。

**解法：强制走 HTTP/2（TCP）**——实测立刻注册成功：

```powershell
& "$env:USERPROFILE\.dsh\dsh-pocket\bin\cloudflared.exe" tunnel --protocol http2 `
  --config "$env:USERPROFILE\.cloudflared\config.yml" run
```

**已固化 + 自愈**：

- 登录自启项 `cloudflared-dsh-tunnel` 已带 `--protocol http2`；
- `tools/setup-named-tunnel-all.ps1`、`tools/_start-named-tunnel.ps1` 也统一加了 `--protocol http2`；
- 面板 agent (`agent.js`) 里有**隧道看护**：每 60 秒查「带 config.yml 的 cloudflared 进程是否存活」，
  每 5 分钟真探一次 `https://mcp.example.com/health`，**连续两次不通就杀掉重启（强制 http2）**。
  日志里能看到 `隧道看护: 首次探活通过 …` / `隧道看护: 公网已恢复`。

**验证恢复**：电脑侧 `mcp/mcp.out.log` 会重新出现手机的 `initialize → notifications/initialized → GET SSE → tools/list`；
手机 dsh 会**自动重连**（它的 MCP 客户端开着 reconnect），不用手动重启。

## 排障：手机上「没有记录 / 会话列表是空的」

按这个顺序查（都是实际踩到的）：

1. **会话索引没共享**：网页的会话列表读的是 `storages/workspace.json` + `storages/session_projcache/`，
   不是 `sessions/` 文件本身。只联接 `sessions` 会出现"文件在、列表空"。
2. **版本不匹配（最隐蔽）**：会话文件格式分 v0（`session.jsonl.zstd`）和 v4（`session.v4.jsonl.zstd`）
   - 命令行版 `@deepseek-ai/dsh` **0.1.x** 的 `SESSION_FORMAT_VERSION = 0`，**读不了** 0.2.x 桌面 App 写的 v4，
     `dsh-session-persistence-jsonl` 会直接 `refuseForeignFormatVersion` → 那些会话在列表里消失；
   - 桌面 App（`@deepseek-ai/dsh-desktop-runtime` 0.2.x）的 `SESSION_FORMAT_VERSION = 4`。
   → 结论：**别自己起旧版 dsh web 去读新版会话**，直接用 App 自己的服务（见下）。
3. **正解**：把转发目标指向**桌面 App 自己的服务**（`127.0.0.1:19387`），
   由 `tools/mint-dsh-cookie.js` 签发会话 cookie 附加到上游（agent 已内置，见上一节）。
   实测：`https://pc.example.com/api/session/list` 返回 **12 条会话，含正在进行的那条**。

排查用的 RPC（0.2.x 的调用形式是**斜杠**命名，`payload.args` 里带 `_request`）：

```bash
curl -s -H "Cookie: $(node tools/mint-dsh-cookie.js --home ~/.dsh --authority 127.0.0.1:19387)" \
  -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"1","method":"session/list","payload":{"args":{"_request":{}}}}' \
  http://127.0.0.1:19387/api/session/list
```

## 「需要确认的事」怎么传到手机上

电脑侧派活是无人值守的（`dsh --profile headless`），默认**不会**向任何人征求确认。这套机制把它接回来了：

```
手机 dsh 派活 (run_task)
   ↓
电脑上跑任务：干到需要拍板的点 → 按约定停下来，输出
        NEED_CONFIRM: <要拍板什么>
        选项: A) ... | B) ... | C) ...
   ↓  dispatcher 扫日志，命中就变成 status=needs_confirm，并抽出问题/选项
手机 dsh：pending_confirmations / task_log 看到「⚠️待你确认」+ 问题
   ↓  用手机 dsh 自己的提问工具（ask_user_question）弹选择题给你
你点一下 → answer_confirmation(id, answer)
   ↓
电脑带着你的答复把原任务继续做完（prompt 不变 + context=你的答复）
```

- 约定文本由 dispatcher 在派活时自动拼在任务前（`CONFIRM_POLICY`，可用环境变量 `MC_NO_CONFIRM_POLICY=1` 关掉）
- 状态值：`needs_confirm`（待确认）→ `confirmed`（已答复）；`mcp__pc__list_tasks` 里显示为 `⚠️待你确认`
- 已答复的确认会自动从队列里消失（`/api/pending` 过滤已答复项）

**实测记录**（2026-10-16）：

```
派活「删除 .tmp 文件，删除前必须先让用户确认」
→ 任务 d0c64afa54 状态 needs_confirm，问题与 A/B/C 选项正确回传
→ answer_confirmation(id, "选 A）确认删除该文件")
→ 新任务 7b8d5dd9a6 继续执行，16 秒完成，文件确实被删
```

> 注意：这套是**任务级**的确认（干到关键决策点停下）。
> **工具级审批**（每一次工具调用都先问你）目前没开 —— PC 侧权限预设是 `danger-full-access`，
> 也就是工具调用全部放行。要改成逐次审批需要给 PC 侧写一个权限审批插件（可后续加）。


---

## 固定地址（命名隧道 `dsh-pc`，2026-10-16 起）

| 地址 | 指向 | 用途 |
| --- | --- | --- |
| `https://mcp.example.com/mcp` | 127.0.0.1:19395 | **手机 DSHA 指挥电脑**（Bearer 令牌见 `../mcp-token.txt`） |
| `https://pc.example.com/?t=<令牌>` | 127.0.0.1:19391 → 3086 | **电脑 dsh 网页（你桌面的那批会话）**：手机上接着做、看实时进度（令牌见 `../dsh-web-token.txt`，Cookie 鉴权） |
| `https://panel.example.com/?t=<令牌>` | 127.0.0.1:19390 | 派活台（抓屏/触控/派活） |
| `https://dsh.example.com/` | 127.0.0.1:3080 | 独立 dsh 网页实例（dsh-web-home） |
| `https://home.example.com/` | 127.0.0.1:3081 | dsh-pocket 入口（PIN `dsh2026go`） |

- 隧道配置：`%USERPROFILE%\.cloudflared\config.yml`（文件里是 ingress 表，四条 hostname）
- 隧道 id：`97242892-009c-4df3-a7d7-f6704e963e42`
- **开机自启**：注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `cloudflared-dsh-tunnel`
  （用户级自启，不需要管理员；管理员版 `schtasks /rl highest` 在本机被拒）
- 域名 NS 在 Cloudflare：`braelyn.ns.cloudflare.com` / `jakub.ns.cloudflare.com`

## 架构

```
手机 DSHA (proot Ubuntu + dsh)   ←→  4G/5G/任意网络
   │  dsh-mcp-client（streamable-http + SSE）
   ▼  https://mcp.example.com/mcp          （固定，Bearer 令牌）
Cloudflare 命名隧道 dsh-pc（电脑侧，登录自启）
   ▼  127.0.0.1:19395
电脑 mcp/pc-mcp-server.js
   ├─→ 任务分发 127.0.0.1:19392 → dsh --profile headless 在电脑上干活
   └─→ PowerShell（run_shell / system_info / open_url）
```

## 令牌与地址记录

| 项 | 值 |
| --- | --- |
| MCP 地址 | `https://mcp.example.com/mcp`（记在 `../mcp-public-url.txt`） |
| MCP 专用令牌 | `../mcp-token.txt`（32 位十六进制，独立于派活台令牌） |

地址已固定，正常情况**不需要再"刷新"**。只有换地址/换令牌时才动手机侧：
在手机 DSHA 终端跑 `bash /sdcard/set-public-url.sh`，然后回「启动」页点「重启」。

`tools/refresh-phone-mcp.ps1` 保留着（把 `mcp-public-url.txt` 的地址写进手机并重启 dsh）。
它有保护逻辑：**固定域名（非 trycloudflare）验证失败时不会新建临时隧道**，只警告——避免误把固定地址换掉。

## 组件

| 文件 | 说明 |
| --- | --- |
| `mcp/pc-mcp-server.js` | 电脑侧 MCP 服务（零依赖，streamable-http + SSE，POST/GET 都支持） |
| `tools/mcp-selftest.js` | MCP 自测：initialize → tools/list → 调工具 → 真派活 |
| `tools/refresh-phone-mcp.ps1` | 把 `mcp-public-url.txt` 的地址写进手机并重启 dsh |
| `tools/setup-named-tunnel-all.ps1` | 一键配命名隧道 + 四个子域 + 自启（换域名时用） |
| `tools/_start-named-tunnel.ps1` | 重建 config.yml、拉起隧道、验证四个地址 |
| `mcp/_set-public-url.sh` | 手机侧脚本模板（`refresh` 会用，手机上是 `/sdcard/set-public-url.sh`） |
| `mcp/install-pc-mcp-on-phone.sh` | 首次注入 MCP 客户端（`insert:` 形式） |
| `mcp/_setup-phone-dsh.sh` | 配手机 dsh 的 API key 与模型设置 |

## 手机侧的注入（关键点）

手机 dsh 的 profile 补丁：`/root/.dsh/profiles/web/cordis.patch.yml`（proot 内，用 DSHA 的「终端」改）。

**新增插件实例必须用 `insert:` 包一层**——直接写 `- id: mcp-pc` 会被 dsh 当成"按 id 覆盖已有条目"，
打一行日志 `patch: entry "mcp-pc" not found` 然后**静默丢弃**（踩过的坑）。正确写法：

```yaml
- insert:
    - id: mcp-pc
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: pc
        transport: streamable-http
        url: https://mcp.example.com/mcp
        headers:
          Authorization: Bearer <token>
        toolCallTimeoutMs: 600000
        failOnStartupError: false      # 关键：端点一时不可达也不能拖垮 dsh 启动
        reconnect:
          enabled: true
          maxAttempts: 50
          maxDelayMs: 60000
```

验证补丁是否被合成（dsh 自己会告诉你）：

```bash
export DSH_HOME=/root/.dsh
node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --dump-config 2>/tmp/e.txt | grep -i -A6 mcp
tail -5 /tmp/e.txt      # patch 的报错/警告会打在这里
```

## 排障：手机 DSHA「启动不了」

**症状**：点「进入」起不来，WebView 显示 `Failed to load plugins`。
DSHA 的日志面板（`/root/dsh-web.log`）里是：

```
failed to apply loader entry mcp-pc (@deepseek-ai/dsh-mcp-client):
  mcp-client(pc): initial connection or tool synchronization failed
[cause]: StreamableHTTPError: ... Error 1033: Cloudflare Tunnel error (530)
        zone: <已经不存在的隧道域名>
Node.js v24.19.0        ← 进程直接退出
```

**原因**：手机 dsh 的 MCP 配置指向的地址已失效（临时隧道被换掉/退役），
而配置里 `failOnStartupError: true` 会让「MCP 插件激活失败」拖垮整个 profile → dsh 起不来。

**处理**：手机 DSHA → 终端 → `bash /sdcard/set-public-url.sh` → 回「启动」点「重启」。
**已加固**：现在配置里是 `failOnStartupError: false`，端点不可达时 dsh 照常启动（只是不注册工具），
这类"启动不了"不会再发生。

## 验证成功的标志

电脑侧 `mcp/mcp.out.log` 出现：

```
rpc initialize
rpc notifications/initialized
GET SSE 流已建立 peer=127.0.0.1
rpc tools/list
```

（peer 显示 127.0.0.1 是因为 cloudflared 跑在电脑本地。）

## 常用命令

```powershell
# 隧道在不在
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Select-Object ProcessId,CommandLine
# 手动拉起
& "$env:USERPROFILE\.dsh\dsh-pocket\bin\cloudflared.exe" tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" run
# 四个地址重新验证
powershell -ExecutionPolicy Bypass -File ..\tools\_start-named-tunnel.ps1
# 电脑侧 MCP 自测（真派活）
node ..\tools\mcp-selftest.js
```

## 备用通道（同 WiFi 时可用，比公网更快）

- **局域网直连**：`url: http://192.168.31.165:19395/mcp`，需放行入站（管理员）：
  `New-NetFirewallRule -DisplayName "PC-MCP-19395" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 19395 -Profile Any`
- **adb 反向通道**：`adb reverse tcp:19395 tcp:19395` + `url: http://127.0.0.1:19395/mcp`
  （手机没连 adb 就用不了）

## 已知限制

- 手机 dsh 得先在 DSHA 里点「进入」把 dsh web 跑起来，MCP 客户端才会连。
- 手机侧 `settings.yaml` 是公开目录的符号链接（`/sdcard/Documents/dshdata/settings.yaml`）；
  `.credentials.yaml` 不在迁移列表里（私有），所以 API key 要用 DSHA 终端写进 proot。
- 手机不是 root、app 非 debuggable，改 proot 里的文件只能走 DSHA 自己的「终端」。
- DSHA 启动页那句「未配置 API key」是 App 自己的标签（它只看自己的配置），
  实际 dsh 的密钥在 `.credentials.yaml` 里、对话能正常跑，忽略即可。
