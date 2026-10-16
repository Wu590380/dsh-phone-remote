## 直接下载安装 APK

仓库根目录的 **pc-dsh.apk** 是**占位符版**（不含任何凭据，安全可公开）。安装后**首次运行会弹出设置框**，填上你自己的四项即可：

| 项 | 例子 | 从哪来 |
| --- | --- | --- |
| MCP 地址 | https://mcp.你的域名/mcp | 隧道里指向 19395 的那条 |
| MCP 令牌 | 一串 hex | mobile-control\mcp-token.txt |
| 面板地址 | https://panel.你的域名 | 隧道里指向 19390 的那条 |
| 面板令牌 | 一串 hex | mobile-control\token.txt |

填一次存在本机（SharedPreferences），顶栏「设置」可随时修改。
想直接构建一个自带凭据的 APK（免手填），就建 secrets.local.json 再跑 app-android\build.ps1。
> **公开仓库说明（重要）**
> 本仓库已脱敏：所有 token、隧道域名、本机用户名都换成了占位符（`YOUR_MCP_TOKEN` / `example.com` / `your-user`）。
> 想真正跑起来，请在**本目录**建一个 `secrets.local.json`（已在 `.gitignore`，不会入库）：
> ```json
> {
>   "mcpUrl":     "https://mcp.你的域名/mcp",
>   "mcpToken":   "你的 MCP 令牌",
>   "panelUrl":   "https://panel.你的域名",
>   "panelToken": "你的面板令牌"
> }
> ```
> 然后直接跑 `app-android\build.ps1`：它会把真值**注入源码副本**再编译，APK 里就是你自己的凭据。
> 没建这个文件也能编译，只是 APK 里是占位符（连不上你的电脑）。APK 本体不入库（`*.apk` 已忽略），请自行构建。


两种用法，按需选一种（也可以同时开）：

| 通道 | 启动 | 特点 |
| --- | --- | --- |
| **公网扫码（推荐，不受局域网限制）** | 双击 `start-public.cmd` | 电脑建 cloudflared 隧道，手机 4G/任何网络扫二维码即用；地址每次启动会变 |
| 局域网直连 | 双击 `start.cmd` | 手机与电脑同一 WiFi/热点/Radmin VPN 时用，延迟最低 |

公网模式做的事：`dsh web`(127.0.0.1:3080) + **dsh-pocket**(公网隧道，8 位/自定义密码) + 手机派活台(抓屏与派活) + 任务分发服务。
启动完会打印公网链接与访问密码，并自动生成 `qr-public.png`（手机扫它就能进）。

---

## 0. 手机上能做什么

手机打开链接（`?token=<密码>` 会带上）后：

![任务页](E:\harness-workspace\mobile-control\preview-tasks.png)

- **任务**：一句话交给电脑上的 dsh，它在电脑上跑完把结果实时送回来（流式）。每个任务是一个独立持久会话，可「再派一次 / 停止 / 删除」。
- **屏幕**：实时电脑画面 + 触控鼠标（点按=左键、长按=右键、双指=滚轮）+ 按键栏 + 命令台。
- **dsh**：一键打开完整 dsh 网页（会话、轨迹、工作区、插件全在），能新开会话、看它一步步干活。

派活链路的实现：`tasks/dispatcher.js` 常驻队列 → `dsh --profile headless -- "<任务>"`（`DSH_HOME=dsh-home`）→ stdout/stderr 边跑边落盘并推给手机。任务文本走 UTF-8 文件传入（`tasks/run-task.ps1`），中文不受命令行编码影响。

任务接口（经派活台端口访问，带同一令牌）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/dispatch/api/task` | 派活，body：`{prompt, workdir?, title?}` |
| GET | `/dispatch/api/tasks?limit=40` | 任务列表 |
| GET | `/dispatch/api/task/log?id=<id>&from=<bytes>` | 任务输出（可增量拉取） |
| POST | `/dispatch/api/task/stop` / `delete` | 停止 / 删除 |
| WS | `/dispatch/ws` | 任务事件流：created/started/output/ended |

---

## 0.5 公网扫码模式的细节（重要）

- **需要 cloudflared**：`winget install cloudflared`，或把 `cloudflared.exe` 放到 `~/.dsh/dsh-pocket/bin/`。`start-public.cmd` 会自动把系统里已有的复制过去，避免插件重复下载。
- **密码**：默认用固定密码 `dsh2026go`（`start-public.cmd` 里可改）；dsh-pocket 也支持每次随机——本脚本为了扫码免改口令而固定。
- **地址会变**：快速隧道每次重启前缀随机。想要固定域名，用 Cloudflare 命名隧道（见下方「固定域名」）。手机只需重新扫一次新码。
- **代理/VPN 会掐隧道**：如果手机打开报 `error 1033`，先关掉 Clash/Surge 等的 **TUN 模式**（不用退出软件），或给 `argotunnel.com`、`trycloudflare.com`、`198.41.192.0/24` 加直连规则。
- **两条通道并存**：公网走 dsh-pocket（3081→3080），局域网走派活台（19390/19391→3080/19392），互不影响。
- **安全**：公网等于把「能在你电脑上执行代码的 dsh」暴露到互联网，务必用强密码、不用时跑 `stop.cmd` 关掉。

### 打不开？按这个顺序查（实测踩过的坑）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 手机显示 **Cloudflare 530 / 1033**，或"无法访问此网站" | **隧道进程已经不在运行**（cloudflared/dsh-pocket 被关掉、或开机后没启动） | 在电脑上重新跑 `start-public.cmd`；用 `Get-Process cloudflared` 确认有进程；确认手机扫的是**最新**二维码 |
| 打开是一个白底"访问验证"页 | 链接里没带 `?token=` | 用二维码扫（内嵌了密码），或手动在地址后加 `/?token=<密码>` |
| 打开报错 1033 但进程在跑 | 本机代理（Clash/dev-sidecar 等）拦截了 cloudflared 到 Cloudflare 边缘的连接 | 关掉代理的 TUN/增强模式，或给 `argotunnel.com`、`trycloudflare.com` 加直连规则 |
| 电脑重启后手机打不开 | 服务不会自启 | 见下方「开机自启」，或每次跑一次 `start-public.cmd` |
| 二维码扫了没反应 | 扫到的是旧图片 | 删除 `qr-public.png` 后重新跑 `start-public.cmd`（会按最新链接重生成） |

> 快速隧道的地址只在**电脑上的隧道进程存活期间**有效；进程一停，链接立刻 530（这就是"昨天能用今天打不开"最常见的原因）。

### 开机自启（可选）

用任务计划把公网模式挂到登录时（会弹一次管理员授权，因为要放行防火墙）：

```powershell
schtasks /create /tn "dsh-pocket-public" /sc onlogon /rl highest /f ^
  /tr "powershell -NoProfile -ExecutionPolicy Bypass -File E:\harness-workspace\mobile-control\start-public.ps1"
schtasks /run /tn "dsh-pocket-public"      # 立即跑一次
schtasks /delete /tn "dsh-pocket-public" /f  # 取消自启
```

开机自启后地址仍会变，需要重新扫码；想要地址固定就上命名隧道。

### 固定域名（可选，Cloudflare 命名隧道）

1. Cloudflare Zero Trust → Networks → Tunnels 建一条隧道，复制 **Tunnel Token**；
2. 该隧道 Public Hostname 里把 `pocket.你的域名` 的 Service 指向 `http://127.0.0.1:3081`；
3. 用 `cloudflared tunnel run --token <TOKEN>` 跑起来（或让 dsh-pocket 的设置页填 Token）；
4. 手机上固定访问 `https://pocket.你的域名/?token=<密码>`。

---

## 1. 局域网模式（30 秒）

1. 双击 **`start.cmd`**（右键「以管理员身份运行」最稳，可自动加防火墙规则）。
2. 窗口会打印手机访问地址，形如：

```
================ 手机远程控制台 ================
访问令牌: YOUR_PANEL_TOKEN
控制面板:  http://192.168.31.165:19390/?t=YOUR_PANEL_TOKEN
   [WLAN]
dsh 完整网页（转发到 127.0.0.1:3080）:
  http://192.168.31.165:19391/
===============================================
```

3. 手机连**同一个 WiFi**（或同一热点 / 同一 Radmin VPN 网络），打开控制面板链接。

停止：双击 **`stop.cmd`**（同时停掉转发用的 dsh web 实例、任务分发服务、公网隧道）。

端口占用一览：

| 端口 | 用途 | 监听范围 |
| --- | --- | --- |
| 3080 | dsh web 本体（公网/局域网两条通道都转发到它） | 127.0.0.1 |
| 3081 | dsh-pocket 代理（公网隧道入口，带密码） | 0.0.0.0 |
| 19390 | 手机派活台（HTTP + WebSocket） | 0.0.0.0（需令牌） |
| 19391 | dsh 网页转发口（局域网免令牌） | 0.0.0.0 |
| 19392 | 任务分发服务 | 127.0.0.1 |

---

## 1. 快速开始（电脑端 30 秒）

1. 双击 **`start.cmd`**（右键 →「以管理员身份运行」最稳，可自动加防火墙规则）。
2. 窗口会打印手机访问地址，形如：

```
================ 手机远程控制台 ================
访问令牌: YOUR_PANEL_TOKEN
控制面板:  http://192.168.31.165:19390/?t=YOUR_PANEL_TOKEN
   [WLAN]
dsh 完整网页（转发到 127.0.0.1:19400）:
  http://192.168.31.165:19391/
===============================================
```

3. 手机连**同一个 WiFi**（或同一个热点 / 同一个 Radmin VPN 网络），浏览器打开「控制面板」那条链接。
4. 建议：手机浏览器里"添加到主屏幕"，下次点图标直接进。

停止：双击 **`stop.cmd`**（同时停掉转发用的独立 dsh 网页实例）。

端口占用一览：

| 端口 | 用途 | 监听范围 |
| --- | --- | --- |
| 19390 | 手机控制面板（HTTP + WebSocket） | 0.0.0.0（局域网可访问，需令牌） |
| 19391 | dsh 完整网页的转发口 | 0.0.0.0（无令牌，仅局域网） |
| 19400 | 独立 dsh 网页实例本体 | 127.0.0.1（只有本机能连） |

---

## 2. 手机控制面板怎么用

打开 `http://<电脑IP>:19390/?t=<令牌>`：

**上半屏：实时画面（约 2 帧/秒）**

| 手势 | 效果 |
| --- | --- |
| 轻点 | 在该位置左键单击 |
| 拖动 | 移动鼠标（限流发送，不会刷爆） |
| 长按 0.5 秒 | 右键单击 |
| 双指分开/捏合 | 滚轮上/下滚动 |

底部「缩放」拉到 200%~600% 可放大画面（放大后单指拖动变成平移，配合点按做精细点击），点「自适应」回到全屏铺满。

**按键栏**：回车 / Esc / Tab / 退格 / 空格 / 复制 / 粘贴 / 全选 / 关窗（Alt+F4）/ 键盘（弹出输入框，最多支持整段中文）/ 右键 / ↑滚 / ↓滚 / 杀进程（终止正在跑的命令）。

**文字输入行**：输入任意文字（含中文、emoji），点「输入」→ 内容进入电脑剪贴板并自动 `Ctrl+V` 打到当前光标处。配合手机输入法就能往电脑里敲中文。

**命令执行行**：写 PowerShell 命令，回车即执行，输出实时回传到底部日志区。
例：`Get-Process | Sort-Object WS -Descending | Select-Object -First 10 Name,Id`。
「入队」按钮则把这条指令写进 `inbox.md`（见第 4 节）。

**预设按钮**：系统信息、网络/IP、当前目录文件、dsh 会话目录、读指令队列、清空队列、抓屏存文件、锁屏、静音切换。想改脚本内容就编辑 `presets.json`（`name` 是按钮文字，`cmd` 是 PowerShell 命令）。

**日志区**：命令输出、执行耗时、退出码，以及每次输入注入的结果。

---

## 3. 手机上用完整的 dsh

点面板上的「打开 dsh 网页」按钮，或直接访问 `http://<电脑IP>:19391/`。

这就是完整的 dsh 网页界面（会话、轨迹、工作区、插件、dsh-purge 都在），手机能新开会话、发任务、看 dsh 干活——和电脑上看到的是同一套东西。

实现要点（也是它为什么能用的原因）：

- dsh 的网页服务拒绝把服务绑到 `0.0.0.0`（`--host 0.0.0.0 is intentionally not supported yet`），并且用「回环权威」校验 Host/Origin，局域网 IP 直连会被判不可信。
- 所以这里不是硬开 0.0.0.0，而是：起一个**只监听 127.0.0.1:19400** 的独立 dsh 网页实例，再由 agent 在 `19391` 做 TCP 隧道，把手机请求的 `Host` / `Origin` 改写成 `127.0.0.1:19400` 再转发过去。手机享受完整功能，dsh 本体依然只在回环上暴露。
- 这个实例使用独立的 `DSH_HOME`（`dsh-web-home/`，从 `~/.dsh/settings.yaml.imported` 拷一份设置），会话历史和桌面版分开，互不干扰；删掉 `dsh-web-home/` 就能重置。
- 首次打开需要**配置一次模型**：桌面版的 `~/.dsh/.credentials.yaml` 用的是嵌套 payload 格式，命令行版 dsh 只认「扁平 `reference: 字符串`」格式，直接拷过去会让实例起不来（`the value for "version" ... must be a string`），所以这里不复制凭据。在手机上按引导填一次 API Key 即可，会写进 `dsh-web-home/.credentials.yaml`，之后一直可用。

---

## 3.5 安卓 App「电脑 dsh」（原生，不用浏览器）

**交付物**：`mobile-control\pc-dsh.apk`（73KB，已签名可直装）；源码在 `mobile-control\app-android\`。

手机上的三个功能：
1. **会话**：列出电脑上全部 dsh 会话（进行中 / 已结束 / 等你确认、轮次、待办 x/y、最后活动），
   每条可「看进度」（`session_progress`）或「接着做」（`session_send` 往那条会话发消息 → 电脑继续干）。
2. **屏幕**：实时看电脑屏幕（轮询派活台 `/api/shot.jpg`，约 1.5 秒一帧）；
   **点图上任意位置 = 在电脑上点那里**（`/api/input` action=click，按屏幕尺寸换算坐标）；
   下方还能「打字」「回车」直接送到电脑键盘。

   > 比例：画面按电脑分辨率**等比缩放居中**（`layoutScreen()` 里 `fitScale = min(可用宽/pcW, 可用高/pcH)`，
   > ImageView 尺寸精确算好后居中），**不会拉伸变形**；点按坐标用同一个 `fitScale` 反算，
   > 横竖屏切换时靠 `addOnLayoutChangeListener` 自动重算。早期用 `FIT_XY` 会被拉伸成手机的比例，
   > 那是错的。
3. 顶部「刷新」。

### 显示规则：中文优先，不给你看 ID 和英文

App 不做"原始输出搬运"，而是解析后重排：

- **会话列表**：状态色块（进行中=绿 / 等你确认=橙 / 已结束=灰）+ 会话标题 +
  「待办 8/10 · 第 50 轮 · 13 秒前」+「正在做：…」+「你上次说：…」，按钮「看进度」「接着做」。
  `session-xxxx-…` 这类 ID、`<system-reminder>` 之类的英文提示**一律不显示**。
- **进度页**：待办逐项中文化（`[completed]`→已完成、`[in_progress]`→正在做、`[pending]`→待做），
  「最近动作」只留工具名（工具原始输出里的哈希串等去噪），最近对话按「电脑：…／你：…」倒序排列；
  工具调用/结果条数与英文原文默认折叠，右上「原始」可展开。
- **屏幕页**：采集端 1400 宽 / JPEG 质量 72 直播（原来是 1100/60，太糊）；
  另有「高清」按钮 → `/api/shot.jpg?w=1920&q=90` 抓一张**原生 1920×1200** 的静图（约 220KB），
  看完点「直播」回到实时画面。
### 改配置 / 重新构建

- 地址与令牌写死在 `app-android/java/com/mc/pcbridge/Config.java`
  （MCP = `https://mcp.example.com/mcp` + mcp-token；派活台 = `https://panel.example.com` + token）。
  令牌换了就改这里再重建。
- 构建（**免 Gradle**：aapt2 + javac + d8 + zipalign + apksigner；需 JDK 21 + SDK 的
  `platforms;android-32` 与 `build-tools;34.0.0`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File mobile-control\app-android\build.ps1
adb install -r mobile-control\app-android\pc-dsh.apk
```

踩过的坑（都已固化进脚本）：
- `d8.bat` 在 JDK 21 上起不来 → 直接 `java -cp build-tools\34.0.0\lib\d8.jar com.android.tools.r8.D8`；
- d8 处理**匿名内部类**会 NPE → 全部改用 lambda；
- JDK 21 不接受 `-bootclasspath` → 用 `--release 11 -cp android.jar`；
- `.ps1` 必须带 **UTF-8 BOM**，否则 PS 5.1 中文解析崩溃；
- keytool 把正常提示写 stderr → 脚本已放宽错误策略。

### 横屏分栏 + 省流（2026-10-17 改版）

- **横屏**（`sensorLandscape`）：只看屏幕时画面等比居中；点「会话」后屏幕缩到左侧（占 1 份），
  右侧腾出 46% 宽度放会话（列表 / 进度 / 输入），「只有屏幕」按钮可把面板收回。
- **省流/高清**：「省流」把采集切到 900 宽 / 质量 50（`/api/quality?w=&q=` 会重启采集进程），
  再点回 1000/55；「高清」按需抓原生 1920×1200 / 质量 90 的静图。
- **字号**：不要改系统缩放，用 dsh 自带的「设置 → 外观 → 字号大小」（说明写着"仅影响会话内容的字号"，
  范围 10–22，建议 20）——只放大 dsh 内容，不动系统其它窗口。

### 手机 App 最终界面（2026-10-17）

- **全屏**：隐藏手机状态栏/导航栏（沉浸式），空间全给画面。
- **顶栏只有 3 个**：`会话`（右栏显示会话列表）、`只有屏幕`（收起右栏、画面居中铺满）、`刷新`。
  没有多余的省流/高清按钮（它们被投诉占地方，删了）。
- **画面手势**：
  - **短按** = 在电脑上点那个位置（等比换算，点哪点哪）
  - **长按** = 焦点给底部输入框，弹手机键盘
  - **双击** = 铺满 / 完整 切换（铺满会裁掉超出部分，字更大；完整则整屏可见、留黑边）
  - **点底部状态行** = 高清静图（原生 1920×1200 / 质量 90）↔ 回实时画面
- **底部输入框（可见）**：打字直接进电脑；`发送` = 只发文字，**长按发送 = 发文字 + 回车**。
  逐字发送会被合并（停顿后才发一串），因为隧道往返要 3~5 秒。
- **打开会话**：画面留在左侧（约 55% 宽），右侧放会话；`← 会话列表` 返回列表，`原始` 看折叠的原始输出。
### 会话列表＝电脑左侧栏的结构（2026-10-17）

- **按工作区分组**：右栏先出工作区标题（`🗂 目录名 (会话数)`），下面挂该目录的会话卡片；
  每组默认显示最近 5 条，多的折叠成「▼ 展开其余 N 个会话」，底部统计「共 N 个工作区 · M 条会话」。
- 每张卡片：状态色块（进行中/等你确认/已结束）+ 标题 + `待办 x/y · 第 N 轮 · 多久前` + `正在做：…`。
- **MCP 调用自动重试 3 次**（每次 12 秒超时）：隧道+5G 偶发回程丢包时不再一次就报 timeout。
### 会话列表＝电脑左侧栏（2026-10-17，重要修正）

手机右栏现在**严格照抄电脑左侧栏**，包括"显示哪些、什么顺序、叫什么名字"：

- 数据源改成电脑自己的 `~/.dsh/storages/workspace.json`：
  工作区顺序与**标题**、每个工作区里会话的**顺序**（`sessionIds`）、**已归档名单**（`archivedSessionIds`）。
- **排除已归档**会话；**排除不属于任何工作区的"野生会话"**（早期用接口建的测试会话就属于这类）——
  这两类电脑侧栏都不显示，之前我的工具全列出来了，所以手机上多出好几条。
  需要排查时用 `sessions` 的 `include_orphans: true` 才会带上。
- 会话行样式与电脑一致：`● 标题`（左）+ `多久前`（右）；**点整行**进进度页（不再堆状态块/待办/按钮）。
- 工作区标题直接用工具给的（不再由路径猜）。
### 手机新建会话 → 电脑界面自动切过去（2026-10-17）

- 需求：手机新建会话后，如果电脑 dsh 还停在老会话，手机上的屏幕就白看了。
- 现状：dsh **没有**"切换当前会话"的接口（session 控制器端点只有 create/rename/archive/pin/排序/打开路径），
  **Ctrl+N 等快捷键也无效** → 纯接口/键盘路走不通。
- 做法：`tools/focus-session.ps1` —— **抓一帧 → 像素分析定位侧栏文字行 → 点中目标行**。
  新会话永远排在工作区第一条，所以「标签 → 工作区标题 → 第一条会话」这个相对位置稳定；
  坐标是**每次实时算出来的**（不是写死数字），窗口移动/缩放也能跟上。
- `session_new` 新增参数 `focus`（默认 true，即自动切换；传 false 则只新建不切界面）。
- 实测：手机新建「手机新建的会话，电脑界面应该自动切过来」→ 电脑窗口标题立刻变成
  「手机端新建会话自动同步电脑界面」，消息区显示首条消息。
### 手机/电脑双向同步：新建会话 + 点开会话（2026-10-17）

**① 手机新建会话 → 电脑界面自动切过去**
- `session_new` 参数 `focus`（默认 true）：新建后后台跑 `tools/focus-session.ps1`，把电脑 dsh 切到新会话。
- **关键教训**：切界面必须**后台跑**。第一版把它同步等了（1.6s + 最多 12s），总耗时超过手机 12s 单次超时 →
  手机自动重试 3 次 → 电脑上建了 3 条一样的会话。现已改成后台 + **90 秒内容去重**（同样第一句话只建一条）。

**② 手机点开某条会话 → 电脑同步切到那条**
- 新增工具 `focus_session { sessionId }`；App 在 `openDetail()` 里顺带调用。
- 切界面**不写死坐标**：抓帧 → 像素分析找侧栏工作区标题（蓝色文件夹图标锚点，找不到就退回固定结构）→ 点它下面第 N 行。
- **闭环自校正**：点完读电脑窗口标题核对，不一致就换个行号再试（快路径：电脑已在该会话则直接返回，3 秒内）。
- 踩过的坑：① 用 `SW_RESTORE` 误把最大化的窗口还原了 → 侧栏坐标全变，改成只在"最小化"时还原；
  ② 读窗口标题时 PowerShell 输出是 GBK → 中文乱码导致核对永远失败，已在命令里强制 `[Console]::OutputEncoding=UTF8`。
### 速度实测（重要）

| 环节 | 结果 |
| --- | --- |
| 采集（常驻进程 shotd.exe，1000 宽/质量55） | **16–22 fps**，52–66KB/帧（原来是每帧起 PowerShell，~2 秒/帧） |
| 本机 WS 二进制推流 | **16 fps**，首帧 8ms |
| 经 Cloudflare 隧道推流 | **0.5–3.6 fps（~1–2 Mbps 上限）** ← 真正的瓶颈 |
| 家宽上行（CF 测速点） | 9–13 Mbps（不是瓶颈） |
| QUIC vs http2 隧道 | 都是 ~1–2 Mbps，换协议无效 |

结论：CF 免费隧道单流吞吐就在 1–2 Mbps。要流畅只有两条路：
1. **P2P 直连**（Tailscale/ZeroTier 之类，装一个就能吃满家宽上行 → 1000px 16fps 无压力）；
2. **H.264 硬编硬解**（同样带宽能到 12–15fps）——但本机 ffmpeg 下载被墙，需要另找来源。
### 为什么没用 fly803/BaseProject 当基座

它的构建链是 **Gradle 5.6.4 + AGP 3.6.3 + support-lib 28（非 AndroidX）+ jcenter**：
Gradle 5.6.4 不支持 JDK 21（要另装 JDK 11），jcenter 已停服，依赖解析大概率失败。
所以这套 App 用**同样的 Java 风格**重写、走免 Gradle 直编——73KB、秒建、零依赖。



| 方式 | 做法 | 适合 |
| --- | --- | --- |
| A. dsh 网页 | 手机上开 `:19391`，像在电脑上一样发消息 | 需要 dsh 的完整能力（读写文件、跑命令、起子任务） |
| B. 指令队列 | 面板里「入队」，把指令写进 `E:\harness-workspace\mobile-control\inbox.md`，再在 dsh 会话里说一句「读一下 mobile-control/inbox.md 并执行」 | 想批量攒任务、事后一起给 dsh |
| C. 直接执行 | 面板命令行写 PowerShell，回车 | 想马上在电脑上跑一条命令、看回显 |

---

## 5. 手机连不上的排查

按顺序查这四步：

1. **同一网段**：手机和电脑必须在同一个可达网络里。电脑上的 `WLAN / 以太网 4` 是普通网络；也可以手机开热点让电脑连（这样电脑 IP 变成 `192.168.137.x` 里的 `192.168.137.1`），或者用已有的 **Radmin VPN** 把两端拉进同一虚拟网（电脑侧对应地址形如 `26.18.222.100`）。
2. **防火墙**：三种网络位置都要放行。用管理员运行一次 `start.cmd` 会自动建好（规则名 `MobileControlPanel-19390` / `-19391`）。也可手动：
   `New-NetFirewallRule -DisplayName MobileControlPanel-19390 -Direction Inbound -Action Allow -Protocol TCP -LocalPort 19390 -Profile Any`
3. **令牌**：控制面板必须带 `?t=令牌`，令牌在 `token.txt` 里；输错会是 401（故意的，防止同网段别人乱点你的电脑）。想换令牌就删掉 `token.txt` 再启动。
4. **画面黑屏**：说明电脑锁屏或已休眠。dsh 运行期间请保持屏幕点亮（电源设置里把"关闭显示器/睡眠"设为"从不"最省事）。

---

## 6. 文件说明

| 文件 | 作用 |
| --- | --- |
| `start.cmd` / `start.ps1` | 一键启动：令牌、防火墙、独立 dsh 网页实例、agent、打印手机地址 |
| `stop.cmd` | 停止 agent + 分发服务 + 独立 dsh 网页实例 |
| `agent.js` | 控制面板服务：HTTP + WebSocket、截图推流、输入注入、命令执行、dsh 网页转发、任务分发转发与自启 |
| `mobile.html` | 手机端页面（任务/屏幕/dsh 三个标签，单文件无 CDN 依赖） |
| `tasks/dispatcher.js` | 任务分发服务：队列、执行、日志、事件流（只监听 127.0.0.1:19392） |
| `tasks/run-task.ps1` | 单个任务的执行入口（UTF-8 文件传任务文本） |
| `tasks/home/` | 任务的 dsh 运行环境（独立 DSH_HOME，会话历史在这里） |
| `tasks/logs/<id>.log` | 每个任务的完整输出 |
| `shot.ps1` | 截图辅助：GDI 抓屏 → 缩放 → JPEG → 二进制写 stdout |
| `input.ps1` | 输入注入辅助：鼠标移动/点击/右键/滚轮、SendKeys、剪贴板粘贴文本 |
| `start-dsh-web.ps1` | 启动只监听回环的独立 dsh 网页实例（独立 DSH_HOME） |
| `fix-encoding.ps1` | 给本目录 `.ps1` 补 UTF-8 BOM（PS 5.1 读无 BOM 中文脚本会乱码报错） |
| `presets.json` | 屏幕面板上的预设命令按钮 |
| `inbox.md` | 指令队列（另一种下指令方式，dsh 可直接读） |
| `token.txt` | 访问令牌 |
| `preview-tasks.png` | 任务页在手机尺寸下的实际渲染截图 |
| `preview-panel.png` | 屏幕页在手机尺寸下的渲染截图 |
| `preview-dsh-web.png` | 转发后的 dsh 网页在手机尺寸下的渲染截图 |
| `tools/` | 自测与调试工具（见下） |

### tools/

```powershell
# 派活链路自测：连 /dispatch/ws → 提交任务 → 实时打印回传内容
node tools\dispatch-selftest.js <令牌> <电脑IP> 19390 "用一句话说明这个系统怎么工作"

# WebSocket 通道体检：直连分发服务 / 面板转发 / 画面通道 / dsh 转发
node tools\ws-check.js <令牌> <电脑IP>

# 端到端自测：WebSocket 握手、收画面帧、跑一条命令、做一次鼠标移动
node tools\selftest.js <令牌> <电脑IP> 19390

# 验证 dsh 网页转发：局域网 Host 访问转发口拿首页 + WebSocket 升级 + 直连对照
node tools\verify-relay.js <电脑IP> 19391 19400

# 看控制面板 WebSocket 的完整握手响应头
node tools\ws-probe.js <令牌> 19390

# 读 Electron app.asar：list 关键字 / cat 单个文件（排查插件实现时用得上）
node tools\asar.js list "<app.asar 路径>" desktop-host
node tools\asar.js cat  "<app.asar 路径>" "/dsh/.../index.js" out.js
```

实测输出（派活链路）：

```
握手: HTTP/1.1 101 Switching Protocols
WS 已连上，历史任务 2 个
[状态] pending
[状态] running
已提交任务 f4baec2c9c（自测任务）
1. 手机端发起：把任务封装成一条消息……
2. 电脑端 dsh 接收并执行……
3. 结果回流：执行中的状态与输出沿同一通道流式回传……
--- 任务结束：done（退出码 0，用时 8 秒）---
```

---

## 7. 自测通过项（本机实测）

- 派活链路：WS `101` → 提交任务 → 收到 `pending/running/output/ended`，任务 `done`、退出码 `0`，中文任务文本完整无损
- 任务输出实时性：执行中逐段推送到手机，日志同时落盘 `tasks/logs/<id>.log`
- 任务隔离：`tasks/home` 独立 DSH_HOME，会话历史与桌面版分开，可随时在 dsh 网页里继续对话
- 控制面板页面：`200`，含实时画面帧、按键栏、预设、命令行
- `GET /api/shot.jpg`：`200 image/jpeg`，1920×1200 真实桌面内容
- 画面通道：WS `101`，持续收到 `frame`（约 2 fps）
- 直接命令下发：`Write-Output ('电脑时间 ' + (Get-Date -Format 'HH:mm:ss')); Get-Location` → 输出与退出码实时回传，`code=0`
- 输入注入：`move` 到指定坐标 `code=0`
- 令牌校验：错误令牌 → `401`
- dsh 网页转发：局域网 Host 访问 `:19391` → `200` 且是 dsh 页面，WebSocket 升级 → `101`
- 四个 WebSocket 通道体检全部 `101`：分发直连、面板转发、画面、dsh 转发
