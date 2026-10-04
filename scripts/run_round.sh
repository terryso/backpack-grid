#!/bin/bash
# Risk exits and replacements run under the same kernel lock. No fee collection here.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then . ./.env; fi
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
if [ "${BG_LOCKED:-}" != "1" ]; then
  exec "${PY_BIN:-python3}" scripts/with_lock.py --wait 45 bash scripts/run_round.sh "$@"
fi
mkdir -p state
node scripts/run_events.cjs start || { echo start_failed > state/last_round_status; exit 1; }
write_status() { echo "$1" > state/last_round_status; node scripts/run_events.cjs end "$1"; }
upload_dashboard() { [ -f scripts/upload_dashboard.sh ] && bash scripts/upload_dashboard.sh || true; }
finish() { write_status "$1"; ROUND_FINISHED=1; upload_dashboard; exit "$2"; }
ROUND_FINISHED=0
round_exit() { if [ "$ROUND_FINISHED" != "1" ]; then write_status aborted || true; fi; }
trap round_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
heartbeat() { node scripts/run_events.cjs heartbeat || true; }
echo "=== ROUND $(date '+%F %T') dryrun=${DRYRUN:-0} ==="
rm -f state/needs_create_plan
heartbeat
if ! bash scripts/ego_dispatch.sh scripts/observe.mjs; then
  echo OBSERVE_FAILED | tee -a state/log.md
  finish observe_failed 1
fi
if ! node scripts/decide.cjs; then
  echo DECIDE_FAILED | tee -a state/log.md
  finish decide_failed 1
fi
if [ "${DRYRUN:-0}" = "1" ]; then
  echo 'DRYRUN: no actions executed.'
  finish dryrun 0
fi
if ! grep -q '"act"' state/actions.json 2>/dev/null; then
  echo 'no actions to execute.'
  finish ok 0
fi
heartbeat
if ! bash scripts/ego_dispatch.sh scripts/act.mjs; then
  node scripts/run_events.cjs actions phase1 || true
  finish act_failed 2
fi
node scripts/run_events.cjs actions phase1 || finish event_failed 1
if [ -f state/needs_create_plan ]; then
  rm -f state/needs_create_plan
  # Failed refresh MUST abort replacements; never reuse a pre-exit snapshot.
  if ! bash scripts/ego_dispatch.sh scripts/observe.mjs; then finish observe_failed_post_exit 1; fi
  if ! BG_PHASE=creates node scripts/decide.cjs; then finish decide_failed_creates 1; fi
  if grep -q '"act"' state/actions.json 2>/dev/null; then
    if ! bash scripts/ego_dispatch.sh scripts/act.mjs; then
      node scripts/run_events.cjs actions phase2 || true
      finish act_failed_creates 2
    fi
    node scripts/run_events.cjs actions phase2 || finish event_failed 1
  fi
fi
if ! bash scripts/ego_dispatch.sh scripts/observe.mjs; then finish observe_failed_confirm 1; fi
finish ok 0
