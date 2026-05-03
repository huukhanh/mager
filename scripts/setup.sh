#!/usr/bin/env bash
# Mager — interactive bootstrapper.
#
# Asks for the bare minimum (instance name + admin password + CF API token),
# auto-detects the Cloudflare account, and provisions the D1 database, KV
# namespace, and Worker config under one consistent naming scheme:
#
#   D1    : <name>-mager
#   KV    : <name>-mager
#   Worker: <name>-mager
#   Pages : <name>-mager
#
# All settings are persisted to .mager.env so re-runs are idempotent.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG_FILE=".mager.env"
WORKER_DIR="$ROOT/worker"

if [ ! -f "$WORKER_DIR/wrangler.toml.template" ]; then
  echo "Error: worker/wrangler.toml.template not found." >&2
  exit 1
fi

WRANGLER_BIN="$WORKER_DIR/node_modules/.bin/wrangler"
if [ ! -x "$WRANGLER_BIN" ]; then
  echo "Error: worker Wrangler not found. Run: cd worker && npm install" >&2
  exit 1
fi

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  echo "Found existing $CONFIG_FILE — press Enter to keep current values."
fi

# 1) Instance name — single source of truth for every resource.
DEFAULT_NAME="${INSTANCE_NAME:-mager}"
read -r -p "Instance name (used as <name>-mager) [$DEFAULT_NAME]: " input
INSTANCE_NAME="${input:-$DEFAULT_NAME}"
if ! [[ "$INSTANCE_NAME" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; then
  echo "Error: instance name must be lowercase letters/digits/hyphens (max 31 chars)." >&2
  exit 1
fi

RESOURCE_NAME="${INSTANCE_NAME}-mager"
DB_NAME="$RESOURCE_NAME"
KV_NAME="$RESOURCE_NAME"
WORKER_NAME="$RESOURCE_NAME"
PAGES_PROJECT_NAME="$RESOURCE_NAME"

# 2) Admin password — hashed and stored only inside KV.
read -r -s -p "Admin password (used to log in to the dashboard): " PASS
echo
if [ -z "$PASS" ]; then
  echo "Error: admin password is required." >&2
  exit 1
fi

# 3) Cloudflare account — try to auto-detect from `wrangler whoami`.
detect_account_id() {
  local out hex_count
  out="$("$WRANGLER_BIN" whoami 2>/dev/null || true)"
  hex_count=$(echo "$out" | grep -oE '[a-f0-9]{32}' | sort -u | wc -l | tr -d ' ')
  if [ "$hex_count" = "1" ]; then
    echo "$out" | grep -oE '[a-f0-9]{32}' | head -1
  fi
}

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(detect_account_id || true)"
fi

if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  read -r -p "Cloudflare account ID [$CLOUDFLARE_ACCOUNT_ID]: " input
  CLOUDFLARE_ACCOUNT_ID="${input:-$CLOUDFLARE_ACCOUNT_ID}"
else
  read -r -p "Cloudflare account ID (https://dash.cloudflare.com → right sidebar): " CLOUDFLARE_ACCOUNT_ID
fi
if ! [[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[a-f0-9]{32}$ ]]; then
  echo "Error: account ID must be 32 hex chars." >&2
  exit 1
fi

# Provision D1 (idempotent: re-use the existing one if its UUID resolves).
echo "→ Ensuring D1 database '$DB_NAME'..."
DB_INFO="$("$WRANGLER_BIN" d1 info "$DB_NAME" --json 2>/dev/null || true)"
if [ -n "$DB_INFO" ] && echo "$DB_INFO" | jq -e '.uuid' >/dev/null 2>&1; then
  DB_ID="$(echo "$DB_INFO" | jq -r '.uuid')"
  echo "  using existing D1 ($DB_ID)."
else
  echo "  creating D1..."
  "$WRANGLER_BIN" d1 create "$DB_NAME"
  DB_INFO="$("$WRANGLER_BIN" d1 info "$DB_NAME" --json)"
  DB_ID="$(echo "$DB_INFO" | jq -r '.uuid')"
fi
if [ -z "$DB_ID" ] || [ "$DB_ID" = "null" ]; then
  echo "Error: failed to resolve D1 database id for '$DB_NAME'." >&2
  exit 1
fi

# Provision KV. Wrangler v3 prints JSON for `kv namespace list`; v4 prints a table.
KV_ID_RE='[a-f0-9]{32}'
find_kv_id() {
  local out=""
  out="$("$WRANGLER_BIN" kv namespace list 2>/dev/null || true)"
  [ -z "$out" ] && return 0
  if command -v jq >/dev/null 2>&1; then
    echo "$out" | jq -r --arg t "$KV_NAME" '
      if type=="array" then
        (map(select((.title // "") as $x | $x==$t or ($x|endswith("-" + $t)) or ($x|endswith("_" + $t)))) | .[0].id // empty)
      else empty end
    ' 2>/dev/null && return 0
  fi
  echo "$out" | grep -i -- "$KV_NAME" | grep -oE "$KV_ID_RE" | head -1
}

echo "→ Ensuring KV namespace '$KV_NAME'..."
KV_ID="$(find_kv_id || true)"
if [ -n "$KV_ID" ] && [ "$KV_ID" != "null" ]; then
  echo "  using existing KV ($KV_ID)."
else
  echo "  creating KV..."
  KV_OUT="$("$WRANGLER_BIN" kv namespace create "$KV_NAME" 2>&1 || true)"
  echo "$KV_OUT"
  KV_ID="$(echo "$KV_OUT" | grep -oE "\"id\"[[:space:]]*:[[:space:]]*\"$KV_ID_RE\"" | grep -oE "$KV_ID_RE" | head -1 || true)"
  if [ -z "$KV_ID" ]; then
    KV_ID="$(echo "$KV_OUT" | grep -oE "$KV_ID_RE" | head -1 || true)"
  fi
  if [ -z "$KV_ID" ]; then
    sleep 2
    KV_ID="$(find_kv_id || true)"
  fi
fi
if [ -z "$KV_ID" ] || [ "$KV_ID" = "null" ]; then
  echo "Error: failed to resolve KV namespace id for '$KV_NAME'." >&2
  echo "Hint: check 'cd worker && npx wrangler kv namespace list' manually." >&2
  exit 1
fi

# Render wrangler.toml from template.
sed \
  -e "s/{{DB_NAME}}/$DB_NAME/g" \
  -e "s/{{DB_ID}}/$DB_ID/g" \
  -e "s/{{KV_NAME}}/$KV_NAME/g" \
  -e "s/{{KV_ID}}/$KV_ID/g" \
  -e "s/{{WORKER_NAME}}/$WORKER_NAME/g" \
  -e "s/{{CLOUDFLARE_ACCOUNT_ID}}/$CLOUDFLARE_ACCOUNT_ID/g" \
  "$WORKER_DIR/wrangler.toml.template" > "$WORKER_DIR/wrangler.toml"

# Hash password and seed it into KV. SESSION_SECRET stays out of disk via wrangler secret.
SESSION_SECRET="$(openssl rand -hex 32)"
HASH="$(node -e "const b=require('bcryptjs');console.log(b.hashSync(process.argv[1],10))" "$PASS")"

cd "$WORKER_DIR"
"$WRANGLER_BIN" kv key put --namespace-id="$KV_ID" "auth:password" "$HASH"
"$WRANGLER_BIN" secret put SESSION_SECRET <<<"$SESSION_SECRET"

# 4) Cloudflare API token used at runtime by the Worker.
echo ""
echo "Cloudflare API token — required permissions:"
echo "  Account | Cloudflare Tunnel : Edit   (creates named tunnels)"
echo "  Zone    | Zone               : Read   (resolves the zone for each ingress hostname)"
echo "  Zone    | DNS                : Edit   (writes the proxied CNAME)"
echo "Account scope: Specific account → $CLOUDFLARE_ACCOUNT_ID"
echo "Zone scope:    All zones from an account (same account)"
echo "Skipping any of those three causes 'permission_denied' or 'zone_not_in_account' on save."
echo "(input hidden — leave empty to set later with: cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN)"
read -r -s -p "CLOUDFLARE_API_TOKEN: " CF_API_TOKEN
echo ""
if [ -n "${CF_API_TOKEN:-}" ]; then
  "$WRANGLER_BIN" secret put CLOUDFLARE_API_TOKEN <<<"$CF_API_TOKEN"
else
  echo "  skipping CLOUDFLARE_API_TOKEN — set it before deploy."
fi

cd "$ROOT"

# Persist everything for `npm run deploy`.
cat > "$CONFIG_FILE" <<EOF
INSTANCE_NAME=$INSTANCE_NAME
DB_NAME=$DB_NAME
KV_NAME=$KV_NAME
WORKER_NAME=$WORKER_NAME
PAGES_PROJECT_NAME=$PAGES_PROJECT_NAME
DB_ID=$DB_ID
KV_ID=$KV_ID
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
WORKER_PUBLIC_URL=${WORKER_PUBLIC_URL:-}
EOF

echo ""
echo "✓ Setup complete. Wrote $CONFIG_FILE and worker/wrangler.toml."
echo "  D1:     $DB_NAME"
echo "  KV:     $KV_NAME"
echo "  Worker: $WORKER_NAME"
echo "  Pages:  $PAGES_PROJECT_NAME"
echo ""
echo "Next: npm run deploy"
