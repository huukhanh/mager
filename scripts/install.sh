#!/usr/bin/env bash
# CloudTunnel Manager — Linux agent installer (systemd).
# Usage:
#   curl -fsSL "$WORKER_URL/install.sh" | sudo bash -s -- --worker-url "$WORKER_URL"
#   curl -fsSL https://raw.githubusercontent.com/huukhanh/cftun-mager/main/scripts/install.sh | sudo bash -s -- --worker-url https://...
#
# Optional env:
#   CLOUDTUNNEL_AGENT_URL — HTTPS URL to a prebuilt linux/{amd64,arm64} binary (chmod +x).
#   CLOUDTUNNEL_SKIP_CLOUDFLARED=1 — do not install cloudflared from GitHub releases.
#   CLOUDTUNNEL_USE_GO_INSTALL=0 — disable "go install" fallback when go is present.

set -euo pipefail

WORKER_URL=""
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"
AGENT_BIN="${AGENT_BIN:-/usr/local/bin/cloudtunnel-agent}"

usage() {
  cat <<EOF
Usage: install.sh --worker-url https://your-worker.workers.dev

Environment:
  CLOUDTUNNEL_AGENT_URL      URL to download the agent binary (linux arch must match).
  CLOUDTUNNEL_SKIP_CLOUDFLARED=1  Skip cloudflared bootstrap.
  CLOUDTUNNEL_USE_GO_INSTALL=0    Disable go install fallback.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--worker-url)
      WORKER_URL="${2:-}"
      shift 2
      ;;
    --worker-url=*)
      WORKER_URL="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer supports Linux only." >&2
  exit 1
fi

if [[ -z "$WORKER_URL" ]]; then
  echo "Missing --worker-url" >&2
  usage >&2
  exit 1
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64 | amd64) CF_ARCH="amd64" ;;
  aarch64 | arm64) CF_ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

echo "→ Ensuring user/group cloudtunnel..."
if ! getent group cloudtunnel >/dev/null 2>&1; then
  groupadd -r cloudtunnel
fi
if ! id cloudtunnel &>/dev/null; then
  useradd -r -g cloudtunnel -s /usr/sbin/nologin -d /var/lib/cloudtunnel cloudtunnel
  mkdir -p /var/lib/cloudtunnel
  chown cloudtunnel:cloudtunnel /var/lib/cloudtunnel
fi

echo "→ Preparing /etc/cloudtunnel..."
mkdir -p /etc/cloudtunnel
chown root:cloudtunnel /etc/cloudtunnel
chmod 0770 /etc/cloudtunnel

umask 077
cat >/etc/cloudtunnel/agent.env <<EOF
CLOUDTUNNEL_WORKER_URL=${WORKER_URL}
EOF
umask 022
chown root:cloudtunnel /etc/cloudtunnel/agent.env
chmod 0640 /etc/cloudtunnel/agent.env

install_cloudflared() {
  if [[ "${CLOUDTUNNEL_SKIP_CLOUDFLARED:-}" == "1" ]]; then
    echo "→ Skipping cloudflared install (CLOUDTUNNEL_SKIP_CLOUDFLARED=1)."
    return 0
  fi
  if command -v cloudflared >/dev/null 2>&1; then
    echo "→ cloudflared already present."
    return 0
  fi
  echo "→ Installing cloudflared (${CF_ARCH})..."
  tmp="$(mktemp)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o "$tmp"
  install -m 0755 "$tmp" "$CLOUDFLARED_BIN"
  rm -f "$tmp"
}

install_agent() {
  if [[ -n "${CLOUDTUNNEL_AGENT_URL:-}" ]]; then
    echo "→ Downloading agent from CLOUDTUNNEL_AGENT_URL..."
    tmp="$(mktemp)"
    curl -fsSL "$CLOUDTUNNEL_AGENT_URL" -o "$tmp"
    install -m 0755 "$tmp" "$AGENT_BIN"
    rm -f "$tmp"
    return 0
  fi

  if command -v go >/dev/null 2>&1 && [[ "${CLOUDTUNNEL_USE_GO_INSTALL:-}" != "0" ]]; then
    echo "→ Installing agent via go install (set CLOUDTUNNEL_USE_GO_INSTALL=0 to disable)..."
    export GOTOOLCHAIN="${GOTOOLCHAIN:-auto}"
    go install github.com/huukhanh/cftun-mager/agent/cmd/cloudtunnel-agent@latest
    GOPATH_BIN="$(go env GOPATH)/bin/cloudtunnel-agent"
    if [[ ! -x "$GOPATH_BIN" ]]; then
      echo "go install did not produce $GOPATH_BIN" >&2
      exit 1
    fi
    install -m 0755 "$GOPATH_BIN" "$AGENT_BIN"
    return 0
  fi

  cat <<EOF >&2
Could not install cloudtunnel-agent.

Either:
  - Install Go and re-run, or
  - Export CLOUDTUNNEL_AGENT_URL to a linux/${CF_ARCH} binary download URL.

Example:
  sudo CLOUDTUNNEL_AGENT_URL=https://example.com/cloudtunnel-agent-linux-${CF_ARCH} \\
    bash -s -- --worker-url ${WORKER_URL}
EOF
  exit 1
}

install_cloudflared
install_agent

cat >/etc/cloudtunnel/start-agent.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
set -a
# shellcheck disable=SC1091
source /etc/cloudtunnel/agent.env
set +a
exec ${AGENT_BIN} -worker-url "\$CLOUDTUNNEL_WORKER_URL" -state-dir /etc/cloudtunnel -cloudflared-path ${CLOUDFLARED_BIN}
EOF

chmod 0755 /etc/cloudtunnel/start-agent.sh
chown root:root /etc/cloudtunnel/start-agent.sh

cat >/etc/systemd/system/cloudtunnel-agent.service <<EOF
[Unit]
Description=CloudTunnel Manager Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cloudtunnel
Group=cloudtunnel
ExecStart=/etc/cloudtunnel/start-agent.sh
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/etc/cloudtunnel /var/lib/cloudtunnel

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cloudtunnel-agent.service
systemctl restart cloudtunnel-agent.service || systemctl start cloudtunnel-agent.service

echo ""
echo "Installed. Check status: systemctl status cloudtunnel-agent"
