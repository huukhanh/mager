#!/usr/bin/env bash
# Mager — Linux agent installer.
# Auto-detects systemd; falls back to a self-managed background daemon for containers / WSL / minimal images.
#
# Usage:
#   curl -fsSL "$WORKER_URL/install.sh" | sudo bash -s -- --worker-url "$WORKER_URL"
#   curl -fsSL https://raw.githubusercontent.com/huukhanh/mager/main/scripts/install.sh | sudo bash -s -- --worker-url https://...
#
# Optional env:
#   MAGER_AGENT_URL              — HTTPS URL to a prebuilt linux/{amd64,arm64} binary (chmod +x).
#   MAGER_AGENT_REPO             — GitHub repo "owner/name" for release fallback (default huukhanh/mager).
#   MAGER_AGENT_TAG              — Release tag (default "latest").
#   MAGER_SKIP_WORKER_DOWNLOAD=1 — do not try ${WORKER_URL}/agent/linux-<arch>.
#   MAGER_SKIP_GITHUB_DOWNLOAD=1 — do not try github.com/<repo>/releases.
#   MAGER_SKIP_CLOUDFLARED=1     — do not install cloudflared from GitHub releases.
#   MAGER_USE_GO_INSTALL=0       — disable "go install" fallback when go is present.
#   MAGER_INIT=systemd|none|auto — force init style (default auto).
#   MAGER_AUTO_START=0           — install only; don't start the agent.

set -euo pipefail

WORKER_URL=""
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"
AGENT_BIN="${AGENT_BIN:-/usr/local/bin/mager-agent}"

usage() {
  cat <<EOF
Usage: install.sh --worker-url https://your-worker.workers.dev

Environment:
  MAGER_AGENT_URL                URL to download the agent binary (linux arch must match).
  MAGER_AGENT_REPO               GitHub repo (default: huukhanh/mager).
  MAGER_AGENT_TAG                Release tag (default: latest).
  MAGER_SKIP_WORKER_DOWNLOAD=1   Skip Worker proxy /agent/linux-<arch>.
  MAGER_SKIP_GITHUB_DOWNLOAD=1   Skip direct GitHub release download.
  MAGER_SKIP_CLOUDFLARED=1       Skip cloudflared bootstrap.
  MAGER_USE_GO_INSTALL=0         Disable go install fallback.
  MAGER_INIT=systemd|none|auto   Force init-system style (default: auto).
  MAGER_AUTO_START=0             Install only; don't start the agent.
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

echo "→ Ensuring user/group mager..."
if ! getent group mager >/dev/null 2>&1; then
  groupadd -r mager
fi
if ! id mager &>/dev/null; then
  useradd -r -g mager -s /usr/sbin/nologin -d /var/lib/mager mager
  mkdir -p /var/lib/mager
  chown mager:mager /var/lib/mager
fi

echo "→ Preparing /etc/mager..."
mkdir -p /etc/mager
chown root:mager /etc/mager
chmod 0770 /etc/mager

umask 077
cat >/etc/mager/agent.env <<EOF
MAGER_WORKER_URL=${WORKER_URL}
EOF
umask 022
chown root:mager /etc/mager/agent.env
chmod 0640 /etc/mager/agent.env

install_cloudflared() {
  if [[ "${MAGER_SKIP_CLOUDFLARED:-}" == "1" ]]; then
    echo "→ Skipping cloudflared install (MAGER_SKIP_CLOUDFLARED=1)."
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
  if [[ -n "${MAGER_AGENT_URL:-}" ]]; then
    echo "→ Downloading agent from MAGER_AGENT_URL..."
    if try_download_agent "$MAGER_AGENT_URL"; then
      return 0
    fi
    echo "✗ MAGER_AGENT_URL download failed." >&2
    exit 1
  fi

  # Worker proxy → 302-redirects to the GitHub release. Default path; no extra config needed.
  if [[ "${MAGER_SKIP_WORKER_DOWNLOAD:-}" != "1" ]]; then
    local worker_dl="${WORKER_URL%/}/agent/linux-${CF_ARCH}"
    echo "→ Trying agent download via Worker: $worker_dl"
    if try_download_agent "$worker_dl"; then
      return 0
    fi
    echo "  Worker download failed; trying alternatives..."
  fi

  # Direct GitHub release fallback (works even if the worker proxy is misconfigured).
  if [[ "${MAGER_SKIP_GITHUB_DOWNLOAD:-}" != "1" ]]; then
    local repo="${MAGER_AGENT_REPO:-huukhanh/mager}"
    local tag="${MAGER_AGENT_TAG:-latest}"
    local gh_url
    if [[ "$tag" == "latest" ]]; then
      gh_url="https://github.com/${repo}/releases/latest/download/mager-agent-linux-${CF_ARCH}"
    else
      gh_url="https://github.com/${repo}/releases/download/${tag}/mager-agent-linux-${CF_ARCH}"
    fi
    echo "→ Trying agent download from GitHub releases: $gh_url"
    if try_download_agent "$gh_url"; then
      return 0
    fi
    echo "  GitHub release download failed."
  fi

  # Local Go build as last resort.
  if command -v go >/dev/null 2>&1 && [[ "${MAGER_USE_GO_INSTALL:-}" != "0" ]]; then
    echo "→ Installing agent via go install (set MAGER_USE_GO_INSTALL=0 to disable)..."
    export GOTOOLCHAIN="${GOTOOLCHAIN:-auto}"
    go install github.com/huukhanh/mager/agent/cmd/mager-agent@latest
    GOPATH_BIN="$(go env GOPATH)/bin/mager-agent"
    if [[ ! -x "$GOPATH_BIN" ]]; then
      echo "go install did not produce $GOPATH_BIN" >&2
      exit 1
    fi
    install -m 0755 "$GOPATH_BIN" "$AGENT_BIN"
    return 0
  fi

  cat <<EOF >&2
Could not install mager-agent.

Tried (in order):
  1. MAGER_AGENT_URL                       (not set)
  2. ${WORKER_URL%/}/agent/linux-${CF_ARCH}   (failed — release may not be published yet)
  3. github.com/huukhanh/mager release      (failed)
  4. go install                             (Go not installed)

Fixes (any one):
  - Publish a GitHub release with mager-agent-linux-${CF_ARCH} as an asset.
  - Install Go (https://go.dev/dl/) and re-run.
  - Pin a different release: MAGER_AGENT_TAG=v0.1.0 sudo bash -s -- --worker-url ${WORKER_URL}
  - Provide a direct URL:
    sudo MAGER_AGENT_URL=https://example.com/mager-agent-linux-${CF_ARCH} \\
      bash -s -- --worker-url ${WORKER_URL}
EOF
  exit 1
}

install_cloudflared
install_agent

cat >/etc/mager/start-agent.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
set -a
# shellcheck disable=SC1091
source /etc/mager/agent.env
set +a
exec ${AGENT_BIN} -worker-url "\$MAGER_WORKER_URL" -state-dir /etc/mager -cloudflared-path ${CLOUDFLARED_BIN}
EOF

chmod 0755 /etc/mager/start-agent.sh
chown root:root /etc/mager/start-agent.sh

# --- init system selection ---------------------------------------------------
# systemd is the default on most Linux distros, but containers / WSL / minimal images
# often run without it (PID 1 is bash/init/etc.). `/run/systemd/system` only exists
# when systemd is the actual init — checking for `systemctl` alone is not enough.
detect_init() {
  case "${MAGER_INIT:-auto}" in
    systemd) echo "systemd"; return ;;
    none)    echo "none"; return ;;
    auto)    : ;;
    *)
      echo "Unknown MAGER_INIT='${MAGER_INIT}'; falling back to auto." >&2
      ;;
  esac
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    echo "systemd"
  else
    echo "none"
  fi
}

INIT_KIND="$(detect_init)"

install_systemd_unit() {
  cat >/etc/systemd/system/mager-agent.service <<EOF
[Unit]
Description=Mager Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mager
Group=mager
ExecStart=/etc/mager/start-agent.sh
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/etc/mager /var/lib/mager

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable mager-agent.service
  if [[ "${MAGER_AUTO_START:-1}" != "0" ]]; then
    systemctl restart mager-agent.service || systemctl start mager-agent.service
  fi
}

# Fallback for non-systemd hosts: a simple PID-file-based daemon controlled by /usr/local/bin/mager-agentctl.
install_pidfile_runner() {
  mkdir -p /var/log/mager /var/run
  chown mager:mager /var/log/mager
  cat >/usr/local/bin/mager-agentctl <<EOF
#!/usr/bin/env bash
# Lightweight start/stop wrapper for hosts without systemd.
set -euo pipefail
PIDFILE=/var/run/mager-agent.pid
LOGFILE=/var/log/mager/agent.log
START_SCRIPT=/etc/mager/start-agent.sh

is_running() {
  [[ -f "\$PIDFILE" ]] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null
}

case "\${1:-status}" in
  start)
    if is_running; then
      echo "mager-agent already running (pid \$(cat "\$PIDFILE"))."
      exit 0
    fi
    if command -v setpriv >/dev/null 2>&1; then
      RUN=(setpriv --reuid=mager --regid=mager --init-groups -- "\$START_SCRIPT")
    elif command -v su >/dev/null 2>&1; then
      RUN=(su -s /bin/bash -c "\$START_SCRIPT" mager)
    else
      RUN=("\$START_SCRIPT")
    fi
    nohup "\${RUN[@]}" >>"\$LOGFILE" 2>&1 &
    echo \$! >"\$PIDFILE"
    sleep 1
    if is_running; then
      echo "mager-agent started (pid \$(cat "\$PIDFILE"))."
    else
      echo "mager-agent failed to start. See \$LOGFILE." >&2
      exit 1
    fi
    ;;
  stop)
    if is_running; then
      kill "\$(cat "\$PIDFILE")"
      sleep 1
      kill -9 "\$(cat "\$PIDFILE")" 2>/dev/null || true
      rm -f "\$PIDFILE"
      echo "mager-agent stopped."
    else
      echo "mager-agent is not running."
    fi
    ;;
  restart)
    "\$0" stop || true
    "\$0" start
    ;;
  status)
    if is_running; then
      echo "mager-agent running (pid \$(cat "\$PIDFILE")). Logs: \$LOGFILE"
    else
      echo "mager-agent stopped."
      exit 3
    fi
    ;;
  logs)
    exec tail -f "\$LOGFILE"
    ;;
  *)
    echo "Usage: \$0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
EOF
  chmod 0755 /usr/local/bin/mager-agentctl
  if [[ "${MAGER_AUTO_START:-1}" != "0" ]]; then
    /usr/local/bin/mager-agentctl restart || /usr/local/bin/mager-agentctl start
  fi
}

case "$INIT_KIND" in
  systemd)
    install_systemd_unit
    echo ""
    echo "Installed (systemd). Status: systemctl status mager-agent"
    echo "Logs:   journalctl -u mager-agent -f"
    ;;
  none)
    install_pidfile_runner
    echo ""
    echo "Installed (no systemd detected — using PID-file runner)."
    echo "Manage with: mager-agentctl {start|stop|restart|status|logs}"
    echo "Logs:        /var/log/mager/agent.log"
    if [[ -f /proc/1/comm ]]; then
      pid1="$(cat /proc/1/comm 2>/dev/null || echo unknown)"
      echo "(PID 1 on this host is '$pid1'; for persistent restarts add this to your container/init manager.)"
    fi
    ;;
esac
