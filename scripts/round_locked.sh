#!/bin/bash
# launchd 入口：以内核 flock 互斥执行一轮巡检（持有者死亡自动释放，无陈旧锁接管路径）
cd "$(dirname "$0")/.."
# launchd gives a minimal PATH: node lives in /usr/local/bin, ego-browser in ~/.local/bin
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
exec python3 scripts/with_lock.py bash scripts/run_round.sh
