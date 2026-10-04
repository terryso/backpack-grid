#!/bin/bash
# ego-browser 不继承 cwd/env：被派发的 mjs 源码里机器相关值写成占位符，
# 由本脚本注入真实路径后经 stdin 交给 ego-browser 执行。
# 用法：scripts/ego_dispatch.sh scripts/observe.mjs   （退出码即 ego-browser 退出码）
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then . ./.env; fi
BG_ROOT="${BG_ROOT:-$PWD}"
PY_BIN="${PY_BIN:-python3}"
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
sed -e "s|__BG_ROOT__|$BG_ROOT|g" -e "s|__PY_BIN__|$PY_BIN|g" "$1" | ego-browser nodejs
