#!/bin/bash
# launchd 入口：以内核 flock 互斥执行一轮巡检（持有者死亡自动释放，无陈旧锁接管路径）
cd "$(dirname "$0")/.."
if [ -f .env ]; then . ./.env; fi
# launchd gives a minimal PATH: node lives in the NODE_BIN dir, ego-browser in ~/.local/bin
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
# 跨任务看门狗：peak_probe 挂死时 launchd 不会重启该任务（StartInterval 单实例语义），
# peak_probe.sh 内的自愈看门狗永远没机会执行——11-04 事故：探针撞上 ego 重启窗口挂死
# 2.4h、round.lock 被占、巡检全 SKIP、网站停更。monitor 每 15 分钟独立触发且不受 peak
# 状态影响，在这里清理存活超过 180 秒的残留探针树（健康采样只占几十秒）。
for pid in $(pgrep -f 'ego_dispatch[.]sh scripts/peak_probe' 2>/dev/null); do
  el=$(ps -p "$pid" -o etimes= 2>/dev/null | tr -d ' ')
  if [ -n "$el" ] && [ "$el" -gt 180 ]; then
    echo "$(date '+%F %T') stale probe tree pid $pid (${el}s) — killing (monitor watchdog)"
    pkill -TERM -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
  fi
done
# --wait 45：与每分钟的峰值探测共用同一把锁；探测采样只占几十秒，等它收尾
# 即可不丢轮次。轮次自身耗时长，后来的调用（--wait 45 超时）跳过不排队。
exec "${PY_BIN:-python3}" scripts/with_lock.py --wait 45 bash scripts/run_round.sh
