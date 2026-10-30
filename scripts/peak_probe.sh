#!/bin/bash
# 轻量峰值采样（每分钟由 launchd 触发）；best-effort，失败静默
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then . ./.env; fi
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p state
# 卡死自愈（10-24 事故：探针 ego 挂起无限等待、占 round.lock 数小时，巡检全 SKIP）：
# 上一次采样进程树存活超过 180 秒即清理——ego 挂起无内建超时，必须在包装层兜底
for pid in $(pgrep -f 'ego_dispatch[.]sh scripts/peak_probe' 2>/dev/null); do
  el=$(ps -p "$pid" -o etimes= 2>/dev/null | tr -d ' ')
  if [ -n "$el" ] && [ "$el" -gt 180 ]; then
    echo "stale probe tree pid $pid (${el}s) — killing"
    pkill -TERM -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
  fi
done
exec >> state/peak_probe.log 2>&1
echo "=== peak probe $(date '+%F %T') ==="
# 与巡检轮次共用 round.lock（统一受保护入口）：轮次进行中立即跳过（exit 3），
# 锁 fd 由业务子进程树共同持有——采样进程树存活期间锁不会提前释放
exec "${PY_BIN:-python3}" scripts/with_lock.py bash -c 'bash scripts/ego_dispatch.sh scripts/peak_probe.mjs'
