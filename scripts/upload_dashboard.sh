#!/bin/bash
# Best effort; report transport/readback status separately from trading-round status.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 0
[ -f state/dashboard.env ] || exit 0
source state/dashboard.env
[ -n "${DASH_URL:-}" ] && [ -n "${DASH_WRITE_TOKEN:-}" ] || exit 0
node scripts/dashboard_data.cjs >/dev/null 2>&1 || { echo 'dashboard build failed (non-fatal)' >&2; exit 0; }
HTTP=$(curl -sS -m 15 -o state/dashboard_upload.response.tmp -w '%{http_code}' -X POST "$DASH_URL/api/snapshot" \
  -H "x-token: $DASH_WRITE_TOKEN" -H 'content-type: application/json' \
  --data-binary @state/dashboard.json) || HTTP=000
READBACK=0
if [ "$HTTP" = '200' ]; then
  if curl -fsS -m 15 "$DASH_URL/api/snapshot" -o state/dashboard_readback.tmp; then
    if node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("state/dashboard.json"));const b=JSON.parse(fs.readFileSync("state/dashboard_readback.tmp"));process.exit(a.updatedAt===b.updatedAt && b.generatedAt===a.generatedAt ? 0:1)'; then READBACK=1; fi
  fi
fi
node - "$HTTP" "$READBACK" <<'JS'
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('state/dashboard.json'));
const status = { at: new Date().toISOString(), httpStatus: Number(process.argv[2]), readBack: process.argv[3] === '1', snapshotAt: s.updatedAt, quotaExhausted: process.argv[2] === '429' };
status.ok = status.httpStatus === 200 && status.readBack;
fs.writeFileSync('state/dashboard_upload.json.tmp', JSON.stringify(status));
fs.renameSync('state/dashboard_upload.json.tmp', 'state/dashboard_upload.json');
console.log(status.ok ? 'dashboard updated and read back' : `dashboard upload/readback failed HTTP ${status.httpStatus} (non-fatal, next scheduled round retries)`);
JS
# Operations history for /ops.html: build from local records and upload only when
# the payload actually changed (hash gate), so quiet rounds cost zero requests.
# ops_data also writes ops_content_hash — the data only, no build timestamp — because
# ops.json bytes change every build (updatedAt) and would defeat the gate.
if node scripts/ops_data.cjs >/dev/null 2>&1; then
  OHASH=$(cat state/ops_content_hash 2>/dev/null || shasum -a 256 state/ops.json | awk '{print $1}')
  if [ "$OHASH" != "$(cat state/ops_upload.hash 2>/dev/null || true)" ]; then
    OHTTP=$(curl -sS -m 20 -o state/ops_upload.response.tmp -w '%{http_code}' -X POST "$DASH_URL/api/ops" \
      -H "x-token: $DASH_WRITE_TOKEN" -H 'content-type: application/json' \
      --data-binary @state/ops.json) || OHTTP=000
    [ "$OHTTP" = "200" ] && printf '%s' "$OHASH" > state/ops_upload.hash
    printf '{"at":"%s","httpStatus":%s}\n' "$(date -u '+%FT%TZ')" "${OHTTP:-000}" > state/ops_upload.json
    rm -f state/ops_upload.response.tmp
  fi
else
  echo 'ops history build failed (non-fatal)' >&2
fi
rm -f state/dashboard_upload.response.tmp state/dashboard_readback.tmp
exit 0
