import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, fetchNodes, logout } from "../api/client";
import type { NodeSummary } from "../types";
import { StatusBadge } from "../components/StatusBadge";

function formatLastSeen(sec: number | null): string {
  if (sec === null) return "—";
  const d = new Date(sec * 1000);
  return d.toLocaleString();
}

export function NodesPage() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<NodeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await fetchNodes();
        if (!cancelled) setNodes(json.nodes);
      } catch (e) {
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 401) {
            logout();
            navigate("/login", { replace: true });
            return;
          }
          setError(e instanceof Error ? e.message : "Failed to load nodes");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="layout">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand-inline">
            <div className="logo sm" aria-hidden />
            <strong>Mager</strong>
          </div>
          <nav className="top-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                logout();
                navigate("/login", { replace: true });
              }}
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="main">
        <div className="page-head">
          <div>
            <h1>Nodes</h1>
            <p className="muted">Edge agents registered with this control plane.</p>
          </div>
        </div>

        {error ? <p className="error">{error}</p> : null}

        {!nodes ? (
          <p className="muted">Loading…</p>
        ) : nodes.length === 0 ? (
          <div className="card empty">
            <h2>No nodes yet</h2>
            <p className="muted">
              Install the Linux agent with your Worker URL; nodes appear here after first registration.
            </p>
          </div>
        ) : (
          <div className="card table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  <th>Tunnel hostname</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.id}>
                    <td className="mono">{n.name}</td>
                    <td>
                      <StatusBadge status={n.status} />
                    </td>
                    <td className="muted">{formatLastSeen(n.lastSeen)}</td>
                    <td className="mono">{n.tunnelHostname ?? "—"}</td>
                    <td className="right">
                      <Link className="btn ghost" to={`/nodes/${n.id}`}>
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
