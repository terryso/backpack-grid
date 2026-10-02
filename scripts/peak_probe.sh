#!/bin/bash
# 轻量峰值采样（每分钟由 launchd 触发）；best-effort，失败静默
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p state
exec >> state/peak_probe.log 2>&1
echo "=== peak probe $(date '+%F %T') ==="
# 与巡检轮次共用 round.lock（统一受保护入口）：轮次进行中立即跳过（exit 3），
# 锁 fd 由业务子进程树共同持有——采样进程树存活期间锁不会提前释放
exec /Users/nick/.browser-use-env/bin/python3 scripts/with_lock.py bash -c 'ego-browser nodejs < scripts/peak_probe.mjs'
