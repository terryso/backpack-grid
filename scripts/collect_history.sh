#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
exec /Users/nick/.browser-use-env/bin/python3 scripts/with_lock.py --name history /bin/bash -c 'if ego-browser nodejs < scripts/collect_history.mjs; then node scripts/history_status.cjs ok; else node scripts/history_status.cjs failed; exit 1; fi'
