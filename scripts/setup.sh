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

WRANGLER_BIN="$WORKER_DIR/node_modules/.bin/wrangler"
if [ ! -x "$WRANGLER_BIN" ]; then
  echo "Error: worker Wrangler not found. Run: cd worker && npm install" >&2
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

# Worker public URL is the base the dashboard uses for API calls. MUST be a full https:// URL.
# Typical shape: https://<WORKER_NAME>.<account-subdomain>.workers.dev
while true; do
  read -r -p "Worker public URL (dashboard API base, e.g. https://${WORKER_NAME}.<subdomain>.workers.dev) [${WORKER_PUBLIC_URL:-}]: " input
  WORKER_PUBLIC_URL=${input:-${WORKER_PUBLIC_URL:-}}
  # Allow empty (optional — skip Pages deploy)
  if [ -z "$WORKER_PUBLIC_URL" ]; then
    break
  fi
  if [[ "$WORKER_PUBLIC_URL" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$ ]]; then
    break
  fi
  echo "  Invalid URL. Must start with http:// or https:// and contain a hostname." >&2
  echo "  Example: https://${WORKER_NAME}.<your-account>.workers.dev" >&2
  WORKER_PUBLIC_URL=""
done

read -r -p "Cloudflare Pages project name (optional) [${PAGES_PROJECT_NAME:-}]: " input
PAGES_PROJECT_NAME=${input:-${PAGES_PROJECT_NAME:-}}

# Setup uses worker/node_modules/.bin/wrangler (same as README's cd worker && npm install), not a global CLI.
# Wrangler 4.x: `d1 info --json` works, but `kv namespace list` outputs table format (no --json flag).
# Parse KV namespace ID from table output or from `kv namespace create` JSON snippet.
echo "Ensuring D1 database '$DB_NAME'..."
DB_INFO="$("$WRANGLER_BIN" d1 info "$DB_NAME" --json 2>/dev/null || true)"
if [ -n "$DB_INFO" ] && echo "$DB_INFO" | jq -e '.uuid' >/dev/null 2>&1; then
  DB_ID="$(echo "$DB_INFO" | jq -r '.uuid')"
  echo "Using existing D1 database ($DB_ID)."
else
  echo "Creating D1 database '$DB_NAME'..."
  "$WRANGLER_BIN" d1 create "$DB_NAME"
  DB_INFO="$("$WRANGLER_BIN" d1 info "$DB_NAME" --json)"
  DB_ID="$(echo "$DB_INFO" | jq -r '.uuid')"
fi
if [ -z "$DB_ID" ] || [ "$DB_ID" = "null" ]; then
  echo "Error: failed to resolve D1 database id for '$DB_NAME'." >&2
  exit 1
fi

echo "Ensuring KV namespace '$KV_NAME'..."
# KV namespace IDs are 32-char hex strings (no dashes), unlike D1's UUIDs.
# `kv namespace` (space) works in both wrangler v3 and v4. v3 outputs JSON for list; v4 outputs table (no --json flag).
# Wrangler also auto-prefixes the title with the worker name (e.g., "worker-<KV_NAME>") when wrangler.toml has no name yet.
KV_ID_RE='[a-f0-9]{32}'

# Helper: find KV ID by listing. Handles both JSON (v3) and table (v4) output formats.
find_kv_id() {
  local out=""
  out="$("$WRANGLER_BIN" kv namespace list 2>/dev/null || true)"
  if [ -z "$out" ]; then
    echo ""
    return 0
  fi
  local found=""
  # Case 1: JSON output (wrangler v3) — parse with jq.
  if command -v jq >/dev/null 2>&1; then
    found="$(echo "$out" | jq -r --arg t "$KV_NAME" '
      if type=="array" then
        (map(select((.title // "") as $x | $x==$t or ($x|endswith("-" + $t)) or ($x|endswith("_" + $t)))) | .[0].id // empty)
      else empty end
    ' 2>/dev/null || true)"
  fi
  # Case 2: Non-JSON output (wrangler v4 table) — grep by name then extract hex id.
  if [ -z "$found" ] || [ "$found" = "null" ]; then
    found="$(echo "$out" | grep -i -- "$KV_NAME" | grep -oE "$KV_ID_RE" | head -1 || true)"
  fi
  echo "$found"
}

KV_ID="$(find_kv_id || true)"
if [ -n "$KV_ID" ]; then
  echo "Using existing KV namespace ($KV_ID)."
else
  echo "Creating KV namespace '$KV_NAME'..."
  KV_CREATE_OUTPUT="$("$WRANGLER_BIN" kv namespace create "$KV_NAME" 2>&1 || true)"
  echo "$KV_CREATE_OUTPUT"
  # Both v3 and v4 print a JSON snippet with "id": "<32-hex>" on success.
  KV_ID="$(echo "$KV_CREATE_OUTPUT" | grep -oE "\"id\"[[:space:]]*:[[:space:]]*\"$KV_ID_RE\"" | grep -oE "$KV_ID_RE" | head -1 || true)"
  if [ -z "$KV_ID" ]; then
    # Fallback: any 32-char hex substring anywhere in the create output.
    KV_ID="$(echo "$KV_CREATE_OUTPUT" | grep -oE "$KV_ID_RE" | head -1 || true)"
  fi
  if [ -z "$KV_ID" ]; then
    sleep 2  # brief wait for propagation
    KV_ID="$(find_kv_id || true)"
  fi
fi
if [ -z "$KV_ID" ] || [ "$KV_ID" = "null" ]; then
  echo "Error: failed to resolve KV namespace id for '$KV_NAME'." >&2
  echo "Hint: check 'cd worker && npx wrangler kv namespace list' manually." >&2
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
# `kv key` (space) works in both v3 and v4. Use --namespace-id to target the just-created namespace directly
# (binding lookup via wrangler.toml can race with fresh namespace propagation).
"$WRANGLER_BIN" kv key put --namespace-id="$KV_ID" "auth:password" "$HASH"
"$WRANGLER_BIN" secret put SESSION_SECRET <<<"$SESSION_SECRET"

echo ""
echo "Enter the Cloudflare API token used by the Worker. Required permissions:"
echo "  - Account     | Cloudflare Tunnel : Edit   (provisions named tunnels)"
echo "  - Zone        | Zone : Read                (resolves zone for each ingress hostname)"
echo "  - Zone        | DNS : Edit                 (creates the <hostname> CNAME proxied to the tunnel)"
echo "Account resource: 'Include → Specific account → ${CLOUDFLARE_ACCOUNT_ID:-<your account>}'"
echo "Zone resource:    'Include → All zones from an account → <same account>' (or per-zone)"
echo "Skipping Zone:Read or DNS:Edit will make ingress save succeed but DNS records WILL NOT be created."
echo "(Input hidden.) Skip now to set later: cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN"
read -r -s -p "CLOUDFLARE_API_TOKEN: " CF_API_TOKEN
echo ""
if [ -n "${CF_API_TOKEN:-}" ]; then
  "$WRANGLER_BIN" secret put CLOUDFLARE_API_TOKEN <<<"$CF_API_TOKEN"
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
