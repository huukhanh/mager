#!/usr/bin/env bash
# CloudTunnel Manager — Linux agent installer (systemd).
# Usage:
#   curl -fsSL "$WORKER_URL/install.sh" | sudo bash -s -- --worker-url "$WORKER_URL"
#   curl -fsSL https://raw.githubusercontent.com/huukhanh/cftun-mager/main/scripts/install.sh | sudo bash -s -- --worker-url https://...
#
# Optional env:
#   CLOUDTUNNEL_AGENT_URL          — HTTPS URL to a prebuilt linux/{amd64,arm64} binary (chmod +x).
#   CLOUDTUNNEL_AGENT_REPO         — GitHub repo "owner/name" for release fallback (default huukhanh/cftun-mager).
#   CLOUDTUNNEL_AGENT_TAG          — Release tag (default "latest").
#   CLOUDTUNNEL_SKIP_WORKER_DOWNLOAD=1   — do not try ${WORKER_URL}/agent/linux-<arch>.
#   CLOUDTUNNEL_SKIP_GITHUB_DOWNLOAD=1   — do not try github.com/<repo>/releases.
#   CLOUDTUNNEL_SKIP_CLOUDFLARED=1 — do not install cloudflared from GitHub releases.
#   CLOUDTUNNEL_USE_GO_INSTALL=0   — disable "go install" fallback when go is present.

set -euo pipefail

WORKER_URL=""
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"
AGENT_BIN="${AGENT_BIN:-/usr/local/bin/cloudtunnel-agent}"

usage() {
  cat <<EOF
Usage: install.sh --worker-url https://your-worker.workers.dev

Environment:
  CLOUDTUNNEL_AGENT_URL                URL to download the agent binary (linux arch must match).
  CLOUDTUNNEL_AGENT_REPO               GitHub repo (default: huukhanh/cftun-mager).
  CLOUDTUNNEL_AGENT_TAG                Release tag (default: latest).
  CLOUDTUNNEL_SKIP_WORKER_DOWNLOAD=1   Skip Worker proxy /agent/linux-<arch>.
  CLOUDTUNNEL_SKIP_GITHUB_DOWNLOAD=1   Skip direct GitHub release download.
  CLOUDTUNNEL_SKIP_CLOUDFLARED=1       Skip cloudflared bootstrap.
  CLOUDTUNNEL_USE_GO_INSTALL=0         Disable go install fallback.
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

try_download_agent() {
  local url="$1"
  local tmp
  tmp="$(mktemp)"
  if curl -fsSL --retry 2 -o "$tmp" "$url"; then
    # Sanity-check: file should be > 1MB and start with ELF (0x7f 'E' 'L' 'F').
    local sz
    sz="$(wc -c <"$tmp" | tr -d ' ')"
    if [[ "$sz" -gt 1048576 ]] && head -c 4 "$tmp" | grep -q $'\x7fELF'; then
      install -m 0755 "$tmp" "$AGENT_BIN"
      rm -f "$tmp"
      return 0
    fi
    echo "  Downloaded file looks invalid (size=$sz, expected ELF binary)." >&2
  fi
  rm -f "$tmp"
  return 1
}

install_agent() {
  # 1) Explicit override.
  if [[ -n "${CLOUDTUNNEL_AGENT_URL:-}" ]]; then
    echo "→ Downloading agent from CLOUDTUNNEL_AGENT_URL..."
    if try_download_agent "$CLOUDTUNNEL_AGENT_URL"; then
      return 0
    fi
    echo "✗ CLOUDTUNNEL_AGENT_URL download failed." >&2
    exit 1
  fi

  # 2) Worker proxy → 302-redirects to GitHub release. Default path; no extra config needed.
  if [[ "${CLOUDTUNNEL_SKIP_WORKER_DOWNLOAD:-}" != "1" ]]; then
    local worker_dl="${WORKER_URL%/}/agent/linux-${CF_ARCH}"
    echo "→ Trying agent download via Worker: $worker_dl"
    if try_download_agent "$worker_dl"; then
      return 0
    fi
    echo "  Worker download failed; trying alternatives..."
  fi

  # 3) Direct GitHub release fallback (works even if worker is misconfigured).
  if [[ "${CLOUDTUNNEL_SKIP_GITHUB_DOWNLOAD:-}" != "1" ]]; then
    local repo="${CLOUDTUNNEL_AGENT_REPO:-huukhanh/cftun-mager}"
    local tag="${CLOUDTUNNEL_AGENT_TAG:-latest}"
    local gh_url
    if [[ "$tag" == "latest" ]]; then
      gh_url="https://github.com/${repo}/releases/latest/download/cloudtunnel-agent-linux-${CF_ARCH}"
    else
      gh_url="https://github.com/${repo}/releases/download/${tag}/cloudtunnel-agent-linux-${CF_ARCH}"
    fi
    echo "→ Trying agent download from GitHub releases: $gh_url"
    if try_download_agent "$gh_url"; then
      return 0
    fi
    echo "  GitHub release download failed."
  fi

  # 4) Local Go build as last resort.
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

Tried (in order):
  1. CLOUDTUNNEL_AGENT_URL              (not set)
  2. ${WORKER_URL%/}/agent/linux-${CF_ARCH}  (failed — release may not be published yet)
  3. github.com/huukhanh/cftun-mager release  (failed)
  4. go install                          (Go not installed)

Fixes (any one):
  - Publish a GitHub release with cloudtunnel-agent-linux-${CF_ARCH} as an asset.
  - Install Go (https://go.dev/dl/) and re-run.
  - Pin a different release: CLOUDTUNNEL_AGENT_TAG=v0.1.0 sudo bash -s -- --worker-url ${WORKER_URL}
  - Provide a direct URL:
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
