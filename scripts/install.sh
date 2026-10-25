#!/usr/bin/env bash
# 榫卯 Tenon · Linux 服务器一键部署（团队/企业形态）
# 用法：bash scripts/install.sh [solo|team|enterprise]
set -euo pipefail
MODE="${1:-team}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "需要 Node.js >= 22：https://nodejs.org"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then echo "Node.js 版本过低（当前 $(node -v)），需要 >= 22"; exit 1; fi
cd "$ROOT"
mkdir -p data
cat > .env <<EOF
TENON_MODE=$MODE
TENON_HOST=0.0.0.0
TENON_PORT=7410
EOF
echo "已写入 .env（模式：$MODE，监听 0.0.0.0:7410）"
echo "启动：node server/start.js"
echo "首次启动会生成 data/secrets.json（操作令牌与节点令牌），请妥善保存。"