import { useState } from "react";
import { workerUrl } from "../api/client";

type Snippet = {
  id: string;
  title: string;
  description?: string;
  command: string;
};

function buildSnippets(worker: string): Snippet[] {
  const w = worker || (typeof window !== "undefined" ? window.location.origin : "");
  return [
    {
      id: "install",
      title: "Install agent (Linux & macOS)",
      description:
        "Run on the host you want to expose. Auto-detects OS/init system and installs cloudflared if needed.",
      command: `curl -fsSL "${w}/install.sh" | sudo bash -s -- --worker-url "${w}"`,
    },
    {
      id: "uninstall",
      title: "Uninstall agent",
      description:
        "Stops the service and removes the binary, state, and logs. Leaves Homebrew's cloudflared alone.",
      command: `curl -fsSL "${w}/install.sh" | sudo bash -s -- --uninstall`,
    },
    {
      id: "logs-linux",
      title: "Tail agent logs — Linux (systemd)",
      command: "sudo journalctl -u mager-agent -f",
    },
    {
      id: "logs-macos",
      title: "Tail agent logs — macOS",
      command: "sudo tail -f /var/log/mager/agent.log",
    },
    {
      id: "restart-linux",
      title: "Restart agent — Linux",
      command: "sudo systemctl restart mager-agent",
    },
    {
      id: "restart-macos",
      title: "Restart agent — macOS",
      command: "sudo launchctl kickstart -k system/com.mager.agent",
    },
    {
      id: "status-linux",
      title: "Status — Linux",
      command: "systemctl status mager-agent",
    },
    {
      id: "status-macos",
      title: "Status — macOS",
      command: "sudo launchctl print system/com.mager.agent | head -20",
    },
  ];
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard API unavailable (e.g. insecure context). Fall back to a
          // selection-based copy so users on http:// admin URLs still get
          // something useful.
          const el = document.createElement("textarea");
          el.value = value;
          el.style.position = "fixed";
          el.style.opacity = "0";
          document.body.appendChild(el);
          el.select();
          try {
            document.execCommand("copy");
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } finally {
            document.body.removeChild(el);
          }
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function CommandsCard() {
  const snippets = buildSnippets(workerUrl());
  return (
    <div className="card commands-card">
      <div className="commands-head">
        <h2>Useful commands</h2>
        <p className="muted">
          Copy-paste from here onto the host. Each install/uninstall command
          embeds your Worker URL, so it's safe to share with operators.
        </p>
      </div>
      <ul className="commands-list">
        {snippets.map((s) => (
          <li key={s.id} className="command-row">
            <div className="command-meta">
              <strong>{s.title}</strong>
              {s.description ? (
                <span className="muted">{s.description}</span>
              ) : null}
            </div>
            <div className="command-snippet">
              <code>{s.command}</code>
              <CopyButton value={s.command} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
