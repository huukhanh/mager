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

read -r -p "Worker public URL (dashboard API base, optional) [${WORKER_PUBLIC_URL:-}]: " input
WORKER_PUBLIC_URL=${input:-${WORKER_PUBLIC_URL:-}}

read -r -p "Cloudflare Pages project name (optional) [${PAGES_PROJECT_NAME:-}]: " input
PAGES_PROJECT_NAME=${input:-${PAGES_PROJECT_NAME:-}}

# Wrangler does not support --json on `d1 create` / `kv namespace create`; passing it fails and was
# swallowed (2>/dev/null), so we fell through to `d1 info` on a missing DB. Resolve id via info/list instead.
echo "Ensuring D1 database '$DB_NAME'..."
DB_INFO="$(wrangler d1 info "$DB_NAME" --json 2>/dev/null || true)"
if [ -n "$DB_INFO" ] && echo "$DB_INFO" | jq -e '.uuid' >/dev/null 2>&1; then
  DB_ID="$(echo "$DB_INFO" | jq -r '.uuid')"
  echo "Using existing D1 database ($DB_ID)."
else
  echo "Creating D1 database '$DB_NAME'..."
  wrangler d1 create "$DB_NAME"
  DB_INFO="$(wrangler d1 info "$DB_NAME" --json)"
  DB_ID="$(echo "$DB_INFO" | jq -r '.uuid')"
fi
if [ -z "$DB_ID" ] || [ "$DB_ID" = "null" ]; then
  echo "Error: failed to resolve D1 database id for '$DB_NAME'." >&2
  exit 1
fi

echo "Ensuring KV namespace '$KV_NAME'..."
KV_ID="$(wrangler kv namespace list --json | jq -r --arg t "$KV_NAME" 'first(.[] | select(.title==$t) | .id) // empty')"
if [ -n "$KV_ID" ]; then
  echo "Using existing KV namespace ($KV_ID)."
else
  echo "Creating KV namespace '$KV_NAME'..."
  wrangler kv namespace create "$KV_NAME"
  KV_ID="$(wrangler kv namespace list --json | jq -r --arg t "$KV_NAME" 'first(.[] | select(.title==$t) | .id) // empty')"
fi
if [ -z "$KV_ID" ] || [ "$KV_ID" = "null" ]; then
  echo "Error: failed to resolve KV namespace id for '$KV_NAME'." >&2
  exit 1
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
WORKER_PUBLIC_URL=$WORKER_PUBLIC_URL
PAGES_PROJECT_NAME=$PAGES_PROJECT_NAME
EOF

echo ""
echo "Setup complete. SESSION_SECRET stored via wrangler secret."
echo "Run 'npm run deploy' from repo root (worker + optional Pages when WORKER_PUBLIC_URL/PAGES_PROJECT_NAME are set)."
