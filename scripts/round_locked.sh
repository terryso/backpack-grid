#!/bin/bash
# launchd 入口：以内核 flock 互斥执行一轮巡检（持有者死亡自动释放，无陈旧锁接管路径）
cd "$(dirname "$0")/.."
if [ -f .env ]; then . ./.env; fi
# launchd gives a minimal PATH: node lives in the NODE_BIN dir, ego-browser in ~/.local/bin
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
# --wait 45：与每分钟的峰值探测共用同一把锁；探测采样只占几十秒，等它收尾
# 即可不丢轮次。轮次自身耗时长，后来的调用（--wait 45 超时）跳过不排队。
exec "${PY_BIN:-python3}" scripts/with_lock.py --wait 45 bash scripts/run_round.sh
