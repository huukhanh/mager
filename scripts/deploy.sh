#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG_FILE=".cloudtunnel.env"
WORKER_DIR="$ROOT/worker"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: .cloudtunnel.env not found. Run 'npm run setup' first."
  exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG_FILE"

if [ ! -f "$WORKER_DIR/wrangler.toml" ]; then
  echo "Error: worker/wrangler.toml missing. Run 'npm run setup' first."
  exit 1
fi

echo "Running D1 migrations..."
(cd "$WORKER_DIR" && wrangler d1 migrations apply "$DB_NAME" --remote)

echo "Deploying worker..."
(cd "$WORKER_DIR" && wrangler deploy)

if [[ -n "${WORKER_PUBLIC_URL:-}" && -n "${PAGES_PROJECT_NAME:-}" ]]; then
  echo "Building dashboard for WORKER_PUBLIC_URL=$WORKER_PUBLIC_URL ..."
  (cd "$ROOT/dashboard" && npm ci && VITE_API_BASE_URL="$WORKER_PUBLIC_URL" npm run build)
  echo "Deploying Cloudflare Pages project '$PAGES_PROJECT_NAME'..."
  (cd "$ROOT/dashboard" && npx wrangler pages deploy dist --project-name="$PAGES_PROJECT_NAME")
else
  echo "Skipping Pages deploy (set WORKER_PUBLIC_URL and PAGES_PROJECT_NAME in $CONFIG_FILE to enable)."
fi
