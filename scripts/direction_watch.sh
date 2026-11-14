#!/bin/bash
# Hourly direction judgement + guarded auto-switch (migrated from the ZCode hourly task).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then . ./.env; fi
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
export BG_PROXY
exec "${PY_BIN:-python3}" scripts/with_lock.py --name direction "${NODE_BIN:-node}" scripts/direction_watch.cjs
