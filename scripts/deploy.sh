#!/usr/bin/env bash
# Mager — apply migrations, deploy the Worker, then build+publish Pages.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG_FILE=".mager.env"
WORKER_DIR="$ROOT/worker"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: $CONFIG_FILE not found. Run 'npm run setup' first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG_FILE"

if [ ! -f "$WORKER_DIR/wrangler.toml" ]; then
  echo "Error: worker/wrangler.toml missing. Run 'npm run setup' first." >&2
  exit 1
fi

echo "→ Applying D1 migrations..."
(cd "$WORKER_DIR" && wrangler d1 migrations apply "$DB_NAME" --remote)

echo "→ Deploying Worker..."
DEPLOY_LOG="$(mktemp)"
trap 'rm -f "$DEPLOY_LOG"' EXIT
(cd "$WORKER_DIR" && wrangler deploy 2>&1 | tee "$DEPLOY_LOG")

# Auto-discover the Worker's public URL from wrangler's deploy summary so the dashboard
# build picks it up without a manual prompt during setup.
DETECTED_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -1 || true)"
if [ -n "$DETECTED_URL" ] && [ "${WORKER_PUBLIC_URL:-}" != "$DETECTED_URL" ]; then
  WORKER_PUBLIC_URL="$DETECTED_URL"
  if grep -q '^WORKER_PUBLIC_URL=' "$CONFIG_FILE"; then
    sed -i.bak "s|^WORKER_PUBLIC_URL=.*$|WORKER_PUBLIC_URL=$WORKER_PUBLIC_URL|" "$CONFIG_FILE"
    rm -f "$CONFIG_FILE.bak"
  else
    echo "WORKER_PUBLIC_URL=$WORKER_PUBLIC_URL" >> "$CONFIG_FILE"
  fi
  echo "→ Detected Worker URL: $WORKER_PUBLIC_URL (saved to $CONFIG_FILE)"
fi

if [ -z "${WORKER_PUBLIC_URL:-}" ]; then
  echo "⚠ Could not detect Worker URL from deploy output. Pages build will be skipped."
  echo "  Set WORKER_PUBLIC_URL in $CONFIG_FILE manually if you want to deploy the dashboard."
  exit 0
fi

if ! [[ "$WORKER_PUBLIC_URL" =~ ^https?:// ]]; then
  echo "Error: WORKER_PUBLIC_URL must start with http(s):// (got: '$WORKER_PUBLIC_URL')." >&2
  echo "Edit $CONFIG_FILE and set a full URL, then re-run." >&2
  exit 1
fi

echo "→ Building dashboard with VITE_API_BASE_URL=$WORKER_PUBLIC_URL ..."
if [ ! -d "$ROOT/dashboard/node_modules" ]; then
  (cd "$ROOT/dashboard" && npm install --no-audit --no-fund)
fi
(cd "$ROOT/dashboard" && VITE_API_BASE_URL="$WORKER_PUBLIC_URL" npm run build)

echo "→ Deploying Cloudflare Pages project '$PAGES_PROJECT_NAME'..."
(cd "$ROOT/dashboard" && npx wrangler pages deploy dist --project-name="$PAGES_PROJECT_NAME")

echo ""
echo "✓ Deploy complete."
echo "  Worker:    $WORKER_PUBLIC_URL"
echo "  Pages:     https://$PAGES_PROJECT_NAME.pages.dev (and any custom domains)"
echo ""
echo "Install agents on Linux nodes:"
echo "  curl -fsSL \"$WORKER_PUBLIC_URL/install.sh\" | sudo bash -s -- --worker-url \"$WORKER_PUBLIC_URL\""
