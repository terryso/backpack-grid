#!/bin/bash
# Public-data research refresh, independent of whether the live portfolio has a slot.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export BG_ROOT="$PWD"
exec /Users/nick/.browser-use-env/bin/python3 scripts/with_lock.py --name research /Users/nick/.nvm/versions/node/v22.14.0/bin/node scripts/analyze.cjs
