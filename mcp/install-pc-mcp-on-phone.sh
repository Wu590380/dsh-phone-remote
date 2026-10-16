#!/bin/bash
# 在手机 DSHA 的 Ubuntu(proot) 环境里执行：把「电脑 MCP 桥」加到 dsh 的 web profile 补丁层。
# 做法：往 /root/.dsh/profiles/web/cordis.patch.yml 追加一个 dsh-mcp-client 实例。
# 幂等 + 先备份 + YAML 校验。
set -u

PC_HOST="${1:-192.168.31.165}"
PC_PORT="${2:-19395}"
PC_TOKEN="${3:-__TOKEN__}"
PROFILE="/root/.dsh/profiles/web"
PATCH="$PROFILE/cordis.patch.yml"
MARK="mcp-pc"

echo "==> 目标: http://$PC_HOST:$PC_PORT/mcp  (profile: $PROFILE)"

if [ ! -d "$PROFILE" ]; then
  echo "!! 找不到 profile 目录 $PROFILE"
  echo "   现有 profile:"; ls -1 /root/.dsh/profiles 2>/dev/null
  exit 1
fi

[ -f "$PATCH" ] || { echo "[]" > "$PATCH"; echo "==> 创建空的 $PATCH"; }

# 已装过就退出
if grep -q "$MARK" "$PATCH" 2>/dev/null; then
  echo "==> 已经装过（$MARK 已存在于 patch）"
  exit 0
fi

cp -a "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null && echo "==> 已备份 patch"

# 空补丁层是字面量 []，必须先去掉才能变成 YAML 数组
sed -i '/^[[:space:]]*\[\][[:space:]]*$/d' "$PATCH" 2>/dev/null
# 去掉行尾多余空行
sed -i -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$PATCH" 2>/dev/null

cat >> "$PATCH" <<EOF

- id: $MARK
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: pc
    transport: streamable-http
    url: http://$PC_HOST:$PC_PORT/mcp
    headers:
      Authorization: Bearer $PC_TOKEN
    toolCallTimeoutMs: 300000
    failOnStartupError: false
EOF

echo "==> 已写入。当前 patch 内容："
cat "$PATCH"

# YAML 合法性检查（dsh 对这个文件很敏感，写坏就起不来）
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import sys
try:
    import yaml
except Exception:
    print("==> 跳过 YAML 校验（没有 pyyaml）"); sys.exit(0)
p = "/root/.dsh/profiles/web/cordis.patch.yml"
try:
    data = yaml.safe_load(open(p, encoding="utf-8"))
except Exception as e:
    print("!! YAML 解析失败: %s" % e); sys.exit(1)
if data is not None and not isinstance(data, list):
    print("!! 结果不是 YAML 数组"); sys.exit(1)
print("==> YAML 校验通过（%d 条补丁）" % (len(data or [])))
PY
fi

echo "==> 完成。请回到「启动」页点一次「重启」，让 dsh 加载这个 MCP 服务器。"
