#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG_FILE=".cloudtunnel.env"
WORKER_DIR="$ROOT/worker"

if [ ! -f "$WORKER_DIR/wrangler.toml.template" ]; then
  echo "Error: worker/wrangler.toml.template not found."
  exit 1
fi

# Load existing config if present (re-run case)
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  echo "Found existing config at $CONFIG_FILE — press Enter to keep current values."
fi

read -r -p "D1 database name [${DB_NAME:-cloudtunnel-db}]: " input
DB_NAME=${input:-${DB_NAME:-cloudtunnel-db}}

read -r -p "KV namespace name [${KV_NAME:-cloudtunnel-kv}]: " input
KV_NAME=${input:-${KV_NAME:-cloudtunnel-kv}}

read -r -p "Worker name [${WORKER_NAME:-cloudtunnel-worker}]: " input
WORKER_NAME=${input:-${WORKER_NAME:-cloudtunnel-worker}}

read -r -s -p "Admin password: " PASS
echo

read -r -p "Cloudflare Account ID [${CLOUDFLARE_ACCOUNT_ID:-}]: " input
CLOUDFLARE_ACCOUNT_ID=${input:-${CLOUDFLARE_ACCOUNT_ID:-}}

echo "Creating D1 database '$DB_NAME'..."
DB_JSON="$(wrangler d1 create "$DB_NAME" --json 2>/dev/null || true)"
if [ -n "$DB_JSON" ] && echo "$DB_JSON" | jq -e '.[0].uuid // .uuid' >/dev/null 2>&1; then
  DB_ID="$(echo "$DB_JSON" | jq -r '.[0].uuid // .uuid')"
else
  DB_ID="$(wrangler d1 info "$DB_NAME" --json | jq -r '.uuid')"
fi

echo "Creating KV namespace '$KV_NAME'..."
KV_JSON="$(wrangler kv namespace create "$KV_NAME" --json 2>/dev/null || true)"
if [ -n "$KV_JSON" ] && echo "$KV_JSON" | jq -e '.id' >/dev/null 2>&1; then
  KV_ID="$(echo "$KV_JSON" | jq -r '.id')"
else
  KV_ID="$(wrangler kv namespace list --json | jq -r --arg t "$KV_NAME" '.[] | select(.title==$t) | .id')"
fi

sed \
  -e "s/{{DB_NAME}}/$DB_NAME/g" \
  -e "s/{{DB_ID}}/$DB_ID/g" \
  -e "s/{{KV_NAME}}/$KV_NAME/g" \
  -e "s/{{KV_ID}}/$KV_ID/g" \
  -e "s/{{WORKER_NAME}}/$WORKER_NAME/g" \
  -e "s/{{CLOUDFLARE_ACCOUNT_ID}}/$CLOUDFLARE_ACCOUNT_ID/g" \
  "$WORKER_DIR/wrangler.toml.template" > "$WORKER_DIR/wrangler.toml"

SESSION_SECRET="$(openssl rand -hex 32)"

HASH="$(node -e "const b=require('bcryptjs');console.log(b.hashSync(process.argv[1],10))" "$PASS")"

cd "$WORKER_DIR"
wrangler kv key put --binding=KV "auth:password" "$HASH"
wrangler secret put SESSION_SECRET <<<"$SESSION_SECRET"

echo ""
echo "Enter Cloudflare API token with Tunnel Write (and DNS Edit if routing later)."
echo "(Input hidden.) If you skip now, run: cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN"
read -r -s -p "CLOUDFLARE_API_TOKEN: " CF_API_TOKEN
echo ""
if [ -n "${CF_API_TOKEN:-}" ]; then
  wrangler secret put CLOUDFLARE_API_TOKEN <<<"$CF_API_TOKEN"
else
  echo "Skipping CLOUDFLARE_API_TOKEN — set it before deploy."
fi

cd "$ROOT"

cat > "$CONFIG_FILE" <<EOF
DB_NAME=$DB_NAME
KV_NAME=$KV_NAME
WORKER_NAME=$WORKER_NAME
DB_ID=$DB_ID
KV_ID=$KV_ID
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
EOF

echo ""
echo "Setup complete. SESSION_SECRET stored via wrangler secret."
echo "Run 'npm run deploy' from repo root to apply migrations and deploy."
