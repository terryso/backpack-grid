#!/bin/bash
# Deploy the dashboard Worker to Cloudflare and wire the upload credentials.
# Prereqs (user-provided, written into state/dashboard.env):
#   CF_ACCOUNT_ID  — Cloudflare account id
#   CF_API_TOKEN     — API token with Workers Scripts:Edit + Workers KV Storage:Edit
# DASH_WRITE_TOKEN (upload key) is generated here if absent. Dashboard reads are public.
set -euo pipefail
export PATH="/Users/nick/.nvm/versions/node/v22.14.0/bin:$PATH"
cd "$(dirname "$0")/.."

[ -f state/dashboard.env ] || { echo "missing state/dashboard.env — see state/dashboard.env.example"; exit 1; }
# shellcheck disable=SC1091
source state/dashboard.env
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID in state/dashboard.env}"
: "${CF_API_TOKEN:?set CF_API_TOKEN in state/dashboard.env}"
[ "${DASH_WRITE_TOKEN:-}" ] || { DASH_WRITE_TOKEN=$(openssl rand -hex 16); echo "DASH_WRITE_TOKEN=$DASH_WRITE_TOKEN" >> state/dashboard.env; }

TOML=cloudflare/wrangler.toml
# account id
if grep -q "CF_ACCOUNT_ID_PLACEHOLDER" "$TOML"; then
  sed -i.bak "s/CF_ACCOUNT_ID_PLACEHOLDER/$CF_ACCOUNT_ID/" "$TOML" && rm -f "$TOML.bak"
fi
# KV namespace (idempotent: only create when placeholder still present)
if grep -q "KV_NAMESPACE_ID_PLACEHOLDER" "$TOML"; then
  echo "creating KV namespace…"
  OUT=$(CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx --no-install wrangler kv namespace create DASH --config cloudflare/wrangler.toml 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -o 'id = "[a-f0-9]*"' | head -1 | grep -o '[a-f0-9]\{32\}')
  [ -n "$ID" ] || { echo "could not parse namespace id from: $OUT"; exit 1; }
  sed -i.bak "s/KV_NAMESPACE_ID_PLACEHOLDER/$ID/" "$TOML" && rm -f "$TOML.bak"
  echo "KV namespace: $ID"
fi

node scripts/build_dashboard.cjs
echo "deploying worker…"
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx --no-install wrangler deploy --config cloudflare/wrangler.toml

echo "setting DASH_WRITE_TOKEN secret…"
printf '%s' "$DASH_WRITE_TOKEN" | CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx --no-install wrangler secret put DASH_WRITE_TOKEN --config cloudflare/wrangler.toml

# derive the workers.dev URL if not provided
if [ -z "${DASH_URL:-}" ]; then
  SUB=$(CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx --no-install wrangler subdomain --account-id "$CF_ACCOUNT_ID" 2>/dev/null | grep -o '[a-z0-9-]*\.workers\.dev' | head -1)
  DASH_URL="https://backpack-grid-dashboard.${SUB:-unknown}.workers.dev"
  echo "DASH_URL=$DASH_URL" >> state/dashboard.env
fi

echo
echo "════════════════════════════════════════════"
echo "部署完成"
echo "仪表盘（公开只读）: $DASH_URL"
echo "上传凭证 DASH_WRITE_TOKEN 已存入 state/dashboard.env（勿提交）"
echo "════════════════════════════════════════════"
