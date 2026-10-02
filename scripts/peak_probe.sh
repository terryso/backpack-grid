#!/bin/bash
# 轻量峰值采样（每分钟由 launchd 触发）；best-effort，失败静默
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p state
exec >> state/peak_probe.log 2>&1
echo "=== peak probe $(date '+%F %T') ==="
ego-browser nodejs < scripts/peak_probe.mjs || echo "peak probe failed"
