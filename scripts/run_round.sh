#!/bin/bash
# One monitoring round: observe -> decide -> (act) -> re-observe.
# Safe by default: DRYRUN=1 plans but never executes.
set -uo pipefail
cd "$(dirname "$0")/.."
# launchd gives a minimal PATH: node lives in /usr/local/bin, ego-browser in ~/.local/bin
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"

mkdir -p state
# --- 锁协议：获取=原子 mkdir；接管=原子 mv 到隔离名（单赢家）+ 存活归还检查；释放=仅自己 pid ---
LOCK=state/lock
release_lock() {
  if [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK" 2>/dev/null; fi
}
write_status() { echo "$1" > state/last_round_status 2>/dev/null || true; }
upload_dashboard() {
  [ -f scripts/upload_dashboard.sh ] && bash scripts/upload_dashboard.sh || true
}
if mkdir "$LOCK" 2>/dev/null; then
  echo $$ > "$LOCK/pid"
else
  HOLDER=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "SKIP: round held by live pid $HOLDER"; exit 0
  fi
  QUAR="state/lock.stale.$$"
  if mv "$LOCK" "$QUAR" 2>/dev/null; then
    QPID=$(cat "$QUAR/pid" 2>/dev/null || true)
    if [ -n "$QPID" ] && kill -0 "$QPID" 2>/dev/null; then
      mv "$QUAR" "$LOCK" 2>/dev/null
      echo "SKIP: stale lock owner came back alive (pid $QPID)"; exit 0
    fi
    echo "took over stale lock (was pid ${QPID:-unknown})"
    rm -rf "$QUAR" 2>/dev/null
  fi
  if mkdir "$LOCK" 2>/dev/null; then
    echo $$ > "$LOCK/pid"
  else
    echo "SKIP: lost fresh-lock race"; exit 0
  fi
fi
trap 'release_lock; upload_dashboard' EXIT

echo "=== ROUND $(date '+%F %T') dryrun=${DRYRUN:-0} ==="
echo "--- observe ---"
if ! ego-browser nodejs < scripts/observe.mjs; then
  osascript -e 'display notification "OBSERVE_FAILED — 无法读取账户状态，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null
  echo "observe_failed" > state/last_round_status
  write_status "observe_failed"
  echo "OBSERVE_FAILED" | tee -a state/log.md; exit 1
fi

echo "--- decide ---"
node scripts/decide.cjs || { osascript -e 'display notification "DECIDE_FAILED — 判定步骤失败，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null; echo "decide_failed" > state/last_round_status; write_status "decide_failed"; echo "DECIDE_FAILED" | tee -a state/log.md; exit 1; }

if [ "${DRYRUN:-0}" = "1" ]; then
  echo "dryrun" > state/last_round_status
  write_status "dryrun"
  echo "DRYRUN: no actions executed."
  exit 0
fi

if ! grep -q '"act"' state/actions.json 2>/dev/null; then
  echo "ok" > state/last_round_status
  write_status "ok"
  echo "no actions to execute."
  exit 0
fi

echo "--- act (phase 1: stops/protects) ---"
if ! ego-browser nodejs < scripts/act.mjs; then
  osascript -e 'display notification "ACT_FAILED — 网格动作执行失败，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null
  echo "act_failed" > state/last_round_status
  write_status "act_failed"
  echo "ACT_FAILED — see state/act_results.json" | tee -a state/log.md; exit 2
fi
# notify on real actions (visible in act output) so rotations are noticeable without opening ZCode
if grep -q '"done": true' state/act_results.json 2>/dev/null; then
  osascript -e 'display notification "执行了网格换仓/保护动作，详情见 state/act_results.json" with title "Backpack 网格巡检"' 2>/dev/null
fi

# phase 2: risk exits executed — refresh state and evaluate replacement creations so a
# stop is never delayed by market analysis (decide defers via state/needs_create_plan)
if [ -f state/needs_create_plan ]; then
  rm -f state/needs_create_plan
  echo "--- re-observe (post-exit) ---"
  ego-browser nodejs < scripts/observe.mjs || true
  echo "--- decide (phase 2: creates) ---"
  if ! BG_PHASE=creates node scripts/decide.cjs; then
    osascript -e 'display notification "DECIDE_FAILED(creates) — 补仓规划失败，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null
    echo "decide_failed_creates" > state/last_round_status
    write_status "decide_failed_creates"
    echo "DECIDE_FAILED(creates)" | tee -a state/log.md; exit 1
  fi
  if grep -q '"act"' state/actions.json 2>/dev/null; then
    echo "--- act (phase 2: creates) ---"
    if ! ego-browser nodejs < scripts/act.mjs; then
      osascript -e 'display notification "ACT_FAILED(create) — 新网格创建失败，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null
      echo "act_failed_creates" > state/last_round_status
      write_status "act_failed_creates"
      echo "ACT_FAILED(creates) — see state/act_results.json" | tee -a state/log.md; exit 2
    fi
  fi
fi

echo "--- re-observe to confirm ---"
ego-browser nodejs < scripts/observe.mjs || true
echo "ok" > state/last_round_status
write_status "ok"
echo "=== ROUND END $(date '+%F %T') ==="
