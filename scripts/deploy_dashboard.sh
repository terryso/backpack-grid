#!/bin/bash
# Deploy the dashboard Worker to Cloudflare and wire the upload credentials.
# Prereqs (user-provided, written into state/dashboard.env):
#   CF_ACCOUNT_ID  — Cloudflare account id
#   CF_API_TOKEN   — API token with Workers Scripts:Edit + Workers KV Storage:Edit
# DASH_TOKEN (upload/read key) is generated here if absent.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f state/dashboard.env ] || { echo "missing state/dashboard.env — see state/dashboard.env.example"; exit 1; }
# shellcheck disable=SC1091
source state/dashboard.env
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID in state/dashboard.env}"
: "${CF_API_TOKEN:?set CF_API_TOKEN in state/dashboard.env}"
[ "${DASH_TOKEN:-}" ] || { DASH_TOKEN=$(openssl rand -hex 16); echo "DASH_TOKEN=$DASH_TOKEN" >> state/dashboard.env; }

TOML=cloudflare/wrangler.toml
# account id
if grep -q "CF_ACCOUNT_ID_PLACEHOLDER" "$TOML"; then
  sed -i.bak "s/CF_ACCOUNT_ID_PLACEHOLDER/$CF_ACCOUNT_ID/" "$TOML" && rm -f "$TOML.bak"
fi
# KV namespace (idempotent: only create when placeholder still present)
if grep -q "KV_NAMESPACE_ID_PLACEHOLDER" "$TOML"; then
  echo "creating KV namespace…"
  OUT=$(CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx -y wrangler@latest kv namespace create DASH --account-id "$CF_ACCOUNT_ID" 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -o 'id = "[a-f0-9]*"' | head -1 | grep -o '[a-f0-9]\{32\}')
  [ -n "$ID" ] || { echo "could not parse namespace id from: $OUT"; exit 1; }
  sed -i.bak "s/KV_NAMESPACE_ID_PLACEHOLDER/$ID/" "$TOML" && rm -f "$TOML.bak"
  echo "KV namespace: $ID"
fi

echo "deploying worker…"
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx -y wrangler@latest deploy --account-id "$CF_ACCOUNT_ID"

echo "setting DASH_TOKEN secret…"
printf '%s' "$DASH_TOKEN" | CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx -y wrangler@latest secret put DASH_TOKEN --account-id "$CF_ACCOUNT_ID"

# derive the workers.dev URL if not provided
if [ -z "${DASH_URL:-}" ]; then
  SUB=$(CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx -y wrangler@latest subdomain --account-id "$CF_ACCOUNT_ID" 2>/dev/null | grep -o '[a-z0-9-]*\.workers\.dev' | head -1)
  DASH_URL="https://backpack-grid-dashboard.${SUB:-unknown}.workers.dev"
  echo "DASH_URL=$DASH_URL" >> state/dashboard.env
fi

echo
echo "════════════════════════════════════════════"
echo "部署完成"
echo "仪表盘（需带访问密钥）: $DASH_URL/?k=$DASH_TOKEN"
echo "上传凭证 DASH_TOKEN 已存入 state/dashboard.env（勿提交）"
echo "════════════════════════════════════════════"
