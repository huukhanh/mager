import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  deleteNode,
  fetchNodeDetail,
  logout,
  patchNodeName,
  putIngress,
} from "../api/client";
import type { IngressRuleEntry, NodeDetail } from "../types";
import { IngressEditor } from "../components/IngressEditor";
import { StatusBadge } from "../components/StatusBadge";

function formatLastSeen(sec: number | null): string {
  if (sec === null) return "—";
  return new Date(sec * 1000).toLocaleString();
}

export function NodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  async function reload() {
    if (!id) return;
    const d = await fetchNodeDetail(id);
    setDetail(d);
    setName(d.name);
  }

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        await reload();
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          logout();
          navigate("/login", { replace: true });
          return;
        }
        if (e instanceof ApiError && e.status === 404) {
          navigate("/", { replace: true });
          return;
        }
        setError(e instanceof Error ? e.message : "Failed to load node");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per id
  }, [id]);

  async function onRename(ev: FormEvent) {
    ev.preventDefault();
    if (!id) return;
    setRenameBusy(true);
    setError(null);
    try {
      await patchNodeName(id, name.trim());
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setRenameBusy(false);
    }
  }

  async function onSaveIngress(ingress: IngressRuleEntry[]) {
    if (!id) return;
    await putIngress(id, ingress);
    await reload();
  }

  async function onDelete() {
    if (!id) return;
    if (
      !confirm(
        "Delete this node? The Cloudflare tunnel will be revoked and the agent will lose access.",
      )
    ) {
      return;
    }
    try {
      await deleteNode(id);
      navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div className="topbar-inner">
          <Link className="link-back" to="/">
            ← Nodes
          </Link>
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
        {!detail ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <div className="page-head split">
              <div>
                <h1 className="inline-wrap">
                  <span className="muted mono">{detail.id.slice(0, 8)}…</span>
                  <StatusBadge status={detail.status} />
                </h1>
                <p className="muted">Last seen {formatLastSeen(detail.lastSeen)}</p>
              </div>
              <button type="button" className="btn danger ghost" onClick={onDelete}>
                Delete node
              </button>
            </div>

            {error ? <p className="error">{error}</p> : null}

            <section className="card stack">
              <h2>Rename</h2>
              <form className="inline-form" onSubmit={onRename}>
                <input
                  className="input"
                  value={name}
                  onChange={(ev) => setName(ev.target.value)}
                  required
                />
                <button className="btn primary" type="submit" disabled={renameBusy}>
                  {renameBusy ? "Saving…" : "Save name"}
                </button>
              </form>
            </section>

            <section className="card">
              <IngressEditor
                key={detail.id}
                initial={detail.ingress}
                onSave={onSaveIngress}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
