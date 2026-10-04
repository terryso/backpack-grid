#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then . ./.env; fi
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
exec "${PY_BIN:-python3}" scripts/with_lock.py --name history /bin/bash -c 'if bash scripts/ego_dispatch.sh scripts/collect_history.mjs; then node scripts/history_status.cjs ok; else node scripts/history_status.cjs failed; exit 1; fi'
