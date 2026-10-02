#!/bin/bash
# Best-effort dashboard upload: build snapshot from state/ and POST to the Worker.
# Requires state/dashboard.env (DASH_URL, DASH_TOKEN). Failures are silent here —
# the monitoring round must never fail because of the dashboard.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f state/dashboard.env ] || exit 0
# shellcheck disable=SC1091
source state/dashboard.env
[ -n "${DASH_URL:-}" ] && [ -n "${DASH_WRITE_TOKEN:-}" ] || exit 0
node scripts/dashboard_data.cjs >/dev/null 2>&1 || {
  echo "dashboard build failed — retrying with stderr:" >&2
  node scripts/dashboard_data.cjs >&2 || { echo "dashboard build failed twice (non-fatal)" >&2; exit 0; }
}
curl -sf -m 15 -X POST "$DASH_URL/api/snapshot" \
  -H "x-token: $DASH_WRITE_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @state/dashboard.json >/dev/null \
  && echo "dashboard updated" || echo "dashboard upload failed (non-fatal)"
exit 0
