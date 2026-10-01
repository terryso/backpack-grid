#!/bin/bash
# One monitoring round: observe -> decide -> (act) -> re-observe.
# Safe by default: DRYRUN=1 plans but never executes.
set -uo pipefail
cd "$(dirname "$0")/.."
# launchd gives a minimal PATH: node lives in /usr/local/bin, ego-browser in ~/.local/bin
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"

mkdir -p state
# PID-based lock: a live holder blocks; a dead/stale holder is taken over; a round only
# ever releases a lock whose recorded pid is its own (no cross-round lock theft)
LOCK=state/lock
release_lock() {
  if [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK" 2>/dev/null; fi
}
if mkdir "$LOCK" 2>/dev/null; then
  echo $$ > "$LOCK/pid"
else
  HOLDER=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "SKIP: round held by live pid $HOLDER"; exit 0
  fi
  # stale or ownerless lock: take over
  echo $$ > "$LOCK/pid"
fi
upload_dashboard() {
  [ -f scripts/upload_dashboard.sh ] && bash scripts/upload_dashboard.sh || true
}
trap 'release_lock; upload_dashboard' EXIT

echo "=== ROUND $(date '+%F %T') dryrun=${DRYRUN:-0} ==="
echo "--- observe ---"
if ! ego-browser nodejs < scripts/observe.mjs; then
  osascript -e 'display notification "OBSERVE_FAILED — 无法读取账户状态，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null
  echo "OBSERVE_FAILED" | tee -a state/log.md; exit 1
fi

echo "--- decide ---"
node scripts/decide.cjs || { osascript -e 'display notification "DECIDE_FAILED — 判定步骤失败，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null; echo "DECIDE_FAILED" | tee -a state/log.md; exit 1; }

if [ "${DRYRUN:-0}" = "1" ]; then
  echo "DRYRUN: no actions executed."
  exit 0
fi

if ! grep -q '"act"' state/actions.json 2>/dev/null; then
  echo "no actions to execute."
  exit 0
fi

echo "--- act (phase 1: stops/protects) ---"
if ! ego-browser nodejs < scripts/act.mjs; then
  osascript -e 'display notification "ACT_FAILED — 网格动作执行失败，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null
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
    echo "DECIDE_FAILED(creates)" | tee -a state/log.md; exit 1
  fi
  if grep -q '"act"' state/actions.json 2>/dev/null; then
    echo "--- act (phase 2: creates) ---"
    if ! ego-browser nodejs < scripts/act.mjs; then
      osascript -e 'display notification "ACT_FAILED(create) — 新网格创建失败，需要检查" with title "Backpack 网格巡检" sound name "Funk"' 2>/dev/null
      echo "ACT_FAILED(creates) — see state/act_results.json" | tee -a state/log.md; exit 2
    fi
  fi
fi

echo "--- re-observe to confirm ---"
ego-browser nodejs < scripts/observe.mjs || true
echo "=== ROUND END $(date '+%F %T') ==="
