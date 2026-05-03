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
