#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
# Separate from round/history. Uses its own Page and serializes reconciled ledger imports.
exec /Users/nick/.browser-use-env/bin/python3 scripts/with_lock.py --name ledger /bin/bash -c 'node scripts/init_verified_window.cjs && if ego-browser nodejs < scripts/collect_verified_window.mjs; then node scripts/window_status.cjs ok; else node scripts/window_status.cjs failed; exit 1; fi'
