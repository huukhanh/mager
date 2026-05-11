#!/usr/bin/env bash
# Mager — agent installer for Linux and macOS.
# Auto-detects the host OS and init system; falls back to a self-managed background daemon
# for containers / WSL / minimal images that have no systemd or launchd.
#
# Usage:
#   curl -fsSL "$WORKER_URL/install.sh" | sudo bash -s -- --worker-url "$WORKER_URL"
#   curl -fsSL https://raw.githubusercontent.com/huukhanh/mager/main/scripts/install.sh | sudo bash -s -- --worker-url https://...
#
# Optional env:
#   MAGER_AGENT_URL              — HTTPS URL to a prebuilt {linux,darwin}/{amd64,arm64} binary (chmod +x).
#   MAGER_AGENT_REPO             — GitHub repo "owner/name" for release fallback (default huukhanh/mager).
#   MAGER_AGENT_TAG              — Release tag (default "latest").
#   MAGER_SKIP_WORKER_DOWNLOAD=1 — do not try ${WORKER_URL}/agent/<os>-<arch>.
#   MAGER_SKIP_GITHUB_DOWNLOAD=1 — do not try github.com/<repo>/releases.
#   MAGER_SKIP_CLOUDFLARED=1     — do not install cloudflared.
#   MAGER_USE_GO_INSTALL=0       — disable "go install" fallback when go is present.
#   MAGER_NO_BREW=1              — on macOS, do not use Homebrew for cloudflared even if available.
#   MAGER_INIT=systemd|launchd|none|auto — force init style (default auto).
#   MAGER_AUTO_START=0           — install only; don't start the agent.

set -euo pipefail

WORKER_URL=""
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"
AGENT_BIN="${AGENT_BIN:-/usr/local/bin/mager-agent}"

usage() {
  cat <<EOF
Usage: install.sh --worker-url https://your-worker.workers.dev

Environment:
  MAGER_AGENT_URL                URL to download the agent binary (must match OS+arch).
  MAGER_AGENT_REPO               GitHub repo (default: huukhanh/mager).
  MAGER_AGENT_TAG                Release tag (default: latest).
  MAGER_SKIP_WORKER_DOWNLOAD=1   Skip Worker proxy /agent/<os>-<arch>.
  MAGER_SKIP_GITHUB_DOWNLOAD=1   Skip direct GitHub release download.
  MAGER_SKIP_CLOUDFLARED=1       Skip cloudflared bootstrap.
  MAGER_USE_GO_INSTALL=0         Disable go install fallback.
  MAGER_NO_BREW=1                On macOS, skip Homebrew for cloudflared.
  MAGER_INIT=systemd|launchd|none|auto
                                 Force init-system style (default: auto).
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

case "$(uname -s)" in
  Linux)  OS_KIND="linux" ;;
  Darwin) OS_KIND="darwin" ;;
  *)
    echo "Unsupported OS: $(uname -s). install.sh supports Linux and macOS." >&2
    exit 1
    ;;
esac

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

# --- system user / state dir -------------------------------------------------
# Linux: dedicated `mager` user owns /var/lib/mager and reads /etc/mager.
# macOS: agent runs as root via LaunchDaemon — no system user, simpler perms.
if [[ "$OS_KIND" == "linux" ]]; then
  echo "→ Ensuring user/group mager..."
  if ! getent group mager >/dev/null 2>&1; then
    groupadd -r mager
  fi
  if ! id mager &>/dev/null; then
    useradd -r -g mager -s /usr/sbin/nologin -d /var/lib/mager mager
    mkdir -p /var/lib/mager
    chown mager:mager /var/lib/mager
  fi
fi

echo "→ Preparing /etc/mager..."
mkdir -p /etc/mager
if [[ "$OS_KIND" == "linux" ]]; then
  chown root:mager /etc/mager
  chmod 0770 /etc/mager
else
  chown root:wheel /etc/mager
  chmod 0750 /etc/mager
fi

umask 077
cat >/etc/mager/agent.env <<EOF
MAGER_WORKER_URL=${WORKER_URL}
EOF
umask 022
if [[ "$OS_KIND" == "linux" ]]; then
  chown root:mager /etc/mager/agent.env
  chmod 0640 /etc/mager/agent.env
else
  chown root:wheel /etc/mager/agent.env
  chmod 0600 /etc/mager/agent.env
fi

# --- cloudflared install -----------------------------------------------------
install_cloudflared() {
  if [[ "${MAGER_SKIP_CLOUDFLARED:-}" == "1" ]]; then
    echo "→ Skipping cloudflared install (MAGER_SKIP_CLOUDFLARED=1)."
    return 0
  fi
  # We need cloudflared at $CLOUDFLARED_BIN specifically — start-agent.sh
  # passes that absolute path to the agent via -cloudflared-path, so a brew
  # install under /opt/homebrew/bin (Apple Silicon default) is invisible
  # to the agent on its own.
  if [[ -x "$CLOUDFLARED_BIN" ]]; then
    echo "→ cloudflared already present at $CLOUDFLARED_BIN."
    return 0
  fi
  if command -v cloudflared >/dev/null 2>&1; then
    local existing
    existing="$(command -v cloudflared)"
    echo "→ Symlinking existing cloudflared ($existing → $CLOUDFLARED_BIN)."
    ln -sf "$existing" "$CLOUDFLARED_BIN"
    return 0
  fi
  if [[ "$OS_KIND" == "linux" ]]; then
    echo "→ Installing cloudflared (linux/${CF_ARCH})..."
    local tmp
    tmp="$(mktemp)"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o "$tmp"
    install -m 0755 "$tmp" "$CLOUDFLARED_BIN"
    rm -f "$tmp"
    return 0
  fi

  # macOS: prefer Homebrew (signed + auto-updated). Fall back to the .tgz release asset.
  if [[ "${MAGER_NO_BREW:-}" != "1" ]] && command -v brew >/dev/null 2>&1; then
    echo "→ Installing cloudflared via Homebrew..."
    # `brew` refuses to run as root; use the invoking user (sudo's SUDO_USER) when available.
    if [[ -n "${SUDO_USER:-}" ]] && [[ "${SUDO_USER}" != "root" ]]; then
      sudo -u "$SUDO_USER" brew install cloudflared
    else
      brew install cloudflared
    fi
    # brew installs to /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel).
    # Symlink it into our canonical path so start-agent.sh can find it.
    if ! command -v cloudflared >/dev/null 2>&1; then
      echo "  brew install completed but cloudflared not on PATH; falling through to tarball." >&2
    else
      local resolved
      resolved="$(command -v cloudflared)"
      if [[ "$resolved" != "$CLOUDFLARED_BIN" ]]; then
        ln -sf "$resolved" "$CLOUDFLARED_BIN"
      fi
      return 0
    fi
  fi

  echo "→ Installing cloudflared (darwin/${CF_ARCH}) from GitHub release tarball..."
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz" \
    -o "$tmpdir/cloudflared.tgz"
  tar -xzf "$tmpdir/cloudflared.tgz" -C "$tmpdir"
  if [[ ! -f "$tmpdir/cloudflared" ]]; then
    echo "✗ cloudflared binary not found inside tarball." >&2
    exit 1
  fi
  install -m 0755 "$tmpdir/cloudflared" "$CLOUDFLARED_BIN"
  xattr -dr com.apple.quarantine "$CLOUDFLARED_BIN" 2>/dev/null || true
}

# --- agent download ----------------------------------------------------------
# Magic-byte sanity check to catch HTML error pages saved as binaries.
is_valid_executable() {
  local f="$1"
  local sz
  sz="$(wc -c <"$f" | tr -d ' ')"
  if [[ "$sz" -lt 1048576 ]]; then
    return 1
  fi
  if [[ "$OS_KIND" == "linux" ]]; then
    head -c 4 "$f" | grep -q $'\x7fELF'
  else
    # Mach-O magic numbers (any of these is a valid macOS executable):
    #   feedfacf  64-bit big-endian
    #   cffaedfe  64-bit little-endian
    #   feedface  32-bit big-endian
    #   cefaedfe  32-bit little-endian
    #   cafebabe  universal (fat) binary
    local hex
    hex="$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')"
    case "$hex" in
      feedfacf|cffaedfe|feedface|cefaedfe|cafebabe) return 0 ;;
      *) return 1 ;;
    esac
  fi
}

try_download_agent() {
  local url="$1"
  local tmp
  tmp="$(mktemp)"
  if curl -fsSL --retry 2 -o "$tmp" "$url"; then
    if is_valid_executable "$tmp"; then
      install -m 0755 "$tmp" "$AGENT_BIN"
      rm -f "$tmp"
      return 0
    fi
    local sz
    sz="$(wc -c <"$tmp" | tr -d ' ')"
    echo "  Downloaded file looks invalid (size=$sz, expected ${OS_KIND} executable)." >&2
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
    local worker_dl="${WORKER_URL%/}/agent/${OS_KIND}-${CF_ARCH}"
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
    local asset="mager-agent-${OS_KIND}-${CF_ARCH}"
    local gh_url
    if [[ "$tag" == "latest" ]]; then
      gh_url="https://github.com/${repo}/releases/latest/download/${asset}"
    else
      gh_url="https://github.com/${repo}/releases/download/${tag}/${asset}"
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
  1. MAGER_AGENT_URL                                   (not set)
  2. ${WORKER_URL%/}/agent/${OS_KIND}-${CF_ARCH}       (failed — release may not be published yet)
  3. github.com/huukhanh/mager release                 (failed)
  4. go install                                        (Go not installed)

Fixes (any one):
  - Publish a GitHub release with mager-agent-${OS_KIND}-${CF_ARCH} as an asset.
  - Install Go (https://go.dev/dl/) and re-run.
  - Pin a different release: MAGER_AGENT_TAG=v0.1.0 sudo bash -s -- --worker-url ${WORKER_URL}
  - Provide a direct URL:
    sudo MAGER_AGENT_URL=https://example.com/mager-agent-${OS_KIND}-${CF_ARCH} \\
      bash -s -- --worker-url ${WORKER_URL}
EOF
  exit 1
}

install_cloudflared
install_agent

# Strip Gatekeeper's quarantine xattr from anything we just installed; otherwise
# launchd refuses to exec the binary on first launch ("Operation not permitted").
if [[ "$OS_KIND" == "darwin" ]]; then
  xattr -dr com.apple.quarantine "$AGENT_BIN" 2>/dev/null || true
  if [[ -e "$CLOUDFLARED_BIN" ]] && [[ ! -L "$CLOUDFLARED_BIN" ]]; then
    xattr -dr com.apple.quarantine "$CLOUDFLARED_BIN" 2>/dev/null || true
  fi
fi

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
chown root:root /etc/mager/start-agent.sh 2>/dev/null || chown root:wheel /etc/mager/start-agent.sh

# --- init system selection ---------------------------------------------------
# Linux: systemd by default; PID-file fallback for containers / WSL / minimal images
#   (`/run/systemd/system` exists only when systemd is the actual init).
# macOS: launchd is always present.
detect_init() {
  case "${MAGER_INIT:-auto}" in
    systemd) echo "systemd"; return ;;
    launchd) echo "launchd"; return ;;
    none)    echo "none"; return ;;
    auto)    : ;;
    *)
      echo "Unknown MAGER_INIT='${MAGER_INIT}'; falling back to auto." >&2
      ;;
  esac
  if [[ "$OS_KIND" == "darwin" ]]; then
    echo "launchd"
  elif [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
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

install_launchd_unit() {
  mkdir -p /var/log/mager
  local plist="/Library/LaunchDaemons/com.mager.agent.plist"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mager.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/etc/mager/start-agent.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/mager/agent.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/mager/agent.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
  chown root:wheel "$plist"
  chmod 0644 "$plist"

  # bootout + bootstrap is the modern (10.10+) way to (re)load a daemon.
  # Older `launchctl load -w` still works but is deprecated.
  launchctl bootout system/com.mager.agent 2>/dev/null || true
  if [[ "${MAGER_AUTO_START:-1}" != "0" ]]; then
    launchctl bootstrap system "$plist"
    launchctl enable system/com.mager.agent 2>/dev/null || true
  fi
}

# Fallback for hosts without a real init system: a simple PID-file daemon controlled by /usr/local/bin/mager-agentctl.
install_pidfile_runner() {
  local rundir="/var/run"
  [[ "$OS_KIND" == "darwin" ]] && rundir="/usr/local/var/run"
  mkdir -p /var/log/mager "$rundir"
  if [[ "$OS_KIND" == "linux" ]]; then
    chown mager:mager /var/log/mager
  fi
  cat >/usr/local/bin/mager-agentctl <<EOF
#!/usr/bin/env bash
# Lightweight start/stop wrapper for hosts without systemd/launchd.
set -euo pipefail
PIDFILE=${rundir}/mager-agent.pid
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
    if command -v setpriv >/dev/null 2>&1 && id mager >/dev/null 2>&1; then
      RUN=(setpriv --reuid=mager --regid=mager --init-groups -- "\$START_SCRIPT")
    elif command -v su >/dev/null 2>&1 && id mager >/dev/null 2>&1; then
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
  launchd)
    install_launchd_unit
    echo ""
    echo "Installed (launchd). Status: sudo launchctl print system/com.mager.agent"
    echo "Logs:   tail -f /var/log/mager/agent.log"
    ;;
  none)
    install_pidfile_runner
    echo ""
    echo "Installed (no init system detected — using PID-file runner)."
    echo "Manage with: mager-agentctl {start|stop|restart|status|logs}"
    echo "Logs:        /var/log/mager/agent.log"
    if [[ -f /proc/1/comm ]]; then
      pid1="$(cat /proc/1/comm 2>/dev/null || echo unknown)"
      echo "(PID 1 on this host is '$pid1'; for persistent restarts add this to your container/init manager.)"
    fi
    ;;
esac
