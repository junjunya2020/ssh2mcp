#!/usr/bin/env bash
# 把 sshmcp 注册为 systemd 服务（需 root）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f dist/main.js ]; then
  echo "[!] 未找到 dist/main.js，先构建：npm install && npm run build"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "[!] 需要 root 权限（sudo）"
  exit 1
fi

node dist/main.js service install >/dev/null
UNIT="$ROOT/service/generated/sshmcp.service"
if [ ! -f "$UNIT" ]; then echo "[!] 未生成 $UNIT"; exit 1; fi

install -m 0644 "$UNIT" /etc/systemd/system/sshmcp.service
systemctl daemon-reload
systemctl enable --now sshmcp
systemctl --no-pager status sshmcp || true

echo
echo "[✓] 已安装并启动。客户端 MCP 配置 (http):"
node dist/main.js config
