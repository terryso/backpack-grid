#!/bin/bash
# Public-data research refresh, independent of whether the live portfolio has a slot.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then . ./.env; fi
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
exec "${PY_BIN:-python3}" scripts/with_lock.py --name research "${NODE_BIN:-node}" scripts/analyze.cjs
