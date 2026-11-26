#!/bin/bash
# Best effort; report transport/readback status separately from trading-round status.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 0
if [ -f .env ]; then . ./.env; fi
[ -f state/dashboard.env ] || exit 0
source state/dashboard.env
[ -n "${DASH_URL:-}" ] && [ -n "${DASH_WRITE_TOKEN:-}" ] || exit 0
node scripts/dashboard_data.cjs >/dev/null 2>&1 || { echo 'dashboard build failed (non-fatal)' >&2; exit 0; }

# 双路自适应：GFW 路由抖动会翻转「直连/代理」哪条可用——10-31 前直连被间歇性重置
# （合盖唤醒后尤其明显）需要走 BG_PROXY；11-01 起代理到本站持续超时而直连 1.4s 通。
# 上次成功的路径记在 state/upload_path 优先尝试，失败自动换另一条。
record_path() { printf '%s' "$1" > state/upload_path; }
methods() {
  local last; last=$(cat state/upload_path 2>/dev/null || echo proxy)
  if [ "$last" = direct ]; then echo direct; [ -n "${BG_PROXY:-}" ] && echo proxy; else echo proxy; echo direct; fi
}
# post_json FILE URL TIMEOUT → 设 POST_HTTP；HTTP 200 返回 0（其余码如 429 也记入 POST_HTTP）。
# a 是未加引号的 curl 参数串（-x URL 不含空格，bash 3.2 兼容）。
post_json() {
  local m a="" f
  for m in $(methods); do
    if [ "$m" = proxy ]; then { [ -n "${BG_PROXY:-}" ] || continue; a="-x $BG_PROXY"; } else a=""; fi
    f=$(curl -sS -m "$3" $a -o "$1.upload.tmp" -w '%{http_code}' -X POST "$2" \
      -H "x-token: $DASH_WRITE_TOKEN" -H 'content-type: application/json' --data-binary @"$1") || f=000
    if [ "$f" = 200 ]; then record_path "$m"; POST_HTTP=200; return 0; fi
    POST_HTTP=$f
  done
  return 1
}
# get_json URL OUT → 走上次成功的路径 GET（readback 只在上传成功后发生）。
get_json() {
  local m a=""
  m=$(cat state/upload_path 2>/dev/null || echo proxy)
  [ "$m" = proxy ] && a="-x $BG_PROXY"
  curl -fsS -m 15 $a "$1" -o "$2"
}

POST_HTTP=000
post_json state/dashboard.json "$DASH_URL/api/snapshot" 15; HTTP=$POST_HTTP
READBACK=0
if [ "$HTTP" = 200 ]; then
  if get_json "$DASH_URL/api/snapshot" state/dashboard_readback.tmp; then
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
# History is rebuilt each round so new fills and actions can be detected, but
# routine-only changes are batched. The snapshot above keeps its original cadence.
upload_ops_history() {
  local mode="$1" OHASH OPS_PAYLOAD OPS_ACTION OPS_TMP_DIR OPS_PLAN
  if ! node scripts/ops_data.cjs >/dev/null 2>&1; then
    echo 'ops history build failed (non-fatal)' >&2
    return 0
  fi
  OHASH=$(cat state/ops_content_hash 2>/dev/null || shasum -a 256 state/ops.json | awk '{print $1}')
  OPS_PAYLOAD=state/ops.json; OPS_ACTION=''; OPS_TMP_DIR=''; OPS_PLAN=''
  if [ "$mode" = policy ]; then
    OPS_TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/backpack-ops-upload.XXXXXXXX" 2>/dev/null) || OPS_TMP_DIR=''
    if [ -n "$OPS_TMP_DIR" ] && cp state/ops.json "$OPS_TMP_DIR/payload.json"; then
      OPS_PLAN="$OPS_TMP_DIR/plan.json"
      OPS_ACTION=$(node scripts/ops_upload_policy.cjs plan "$OPS_TMP_DIR/payload.json" "$OPS_PLAN" 2>/dev/null) || OPS_ACTION=''
      case "$OPS_ACTION" in upload|skip) OPS_PAYLOAD="$OPS_TMP_DIR/payload.json" ;; *) OPS_ACTION=''; OPS_PLAN='' ;; esac
    fi
  fi
  # Missing policy, temp directory or lock support falls back to the old
  # immediate hash gate rather than silently suppressing a history update.
  if [ -z "$OPS_ACTION" ]; then
    OPS_PLAN=''
    if [ "$OHASH" = "$(cat state/ops_upload.hash 2>/dev/null || true)" ]; then OPS_ACTION=skip; else OPS_ACTION=upload; fi
  fi
  if [ "$OPS_ACTION" = upload ]; then
    POST_HTTP=000
    if post_json "$OPS_PAYLOAD" "$DASH_URL/api/ops" 20; then
      if [ -z "$OPS_PLAN" ] || ! node scripts/ops_upload_policy.cjs commit "$OPS_PLAN" >/dev/null 2>&1; then
        printf '%s' "$OHASH" > state/ops_upload.hash
      fi
    fi
    # curl reports network failure as 000, which is not a valid JSON number.
    [ "$POST_HTTP" = 000 ] && POST_HTTP=0
    printf '{"at":"%s","httpStatus":%s}\n' "$(date -u '+%FT%TZ')" "$POST_HTTP" > state/ops_upload.json
    rm -f "$OPS_PAYLOAD.upload.tmp"
  fi
  if [ -n "$OPS_TMP_DIR" ]; then
    rm -f "$OPS_TMP_DIR/payload.json" "$OPS_TMP_DIR/plan.json" "$OPS_TMP_DIR/payload.json.upload.tmp"
    rmdir "$OPS_TMP_DIR" 2>/dev/null || true
  fi
  return 0
}
# A separate, nonblocking kernel lock prevents a simultaneous manual upload
# from publishing an older history after a newer one. Busy means retry on the
# next invocation; it never delays observation or trading.
if [ -x /usr/bin/lockf ]; then
  (
    /usr/bin/lockf -s -t 0 9; OPS_LOCK_STATUS=$?
    if [ "$OPS_LOCK_STATUS" -eq 75 ]; then echo 'ops history upload busy; next round retries'; exit 0; fi
    [ "$OPS_LOCK_STATUS" -eq 0 ] || exit 1
    upload_ops_history policy
  ) 9>>state/ops_upload.lock || upload_ops_history legacy
else
  upload_ops_history legacy
fi
rm -f state/dashboard.json.upload.tmp state/dashboard_readback.tmp
exit 0
