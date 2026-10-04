#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then . ./.env; fi
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
# Separate from round/history. Uses its own Page and serializes reconciled ledger imports.
exec "${PY_BIN:-python3}" scripts/with_lock.py --name ledger /bin/bash -c 'node scripts/init_verified_window.cjs && if bash scripts/ego_dispatch.sh scripts/collect_verified_window.mjs; then node scripts/window_status.cjs ok; else node scripts/window_status.cjs failed; exit 1; fi'
