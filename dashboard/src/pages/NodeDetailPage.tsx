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
import type {
  DnsProvisionOutcome,
  IngressRuleEntry,
  NodeDetail,
} from "../types";
import { IngressEditor } from "../components/IngressEditor";
import { StatusBadge } from "../components/StatusBadge";

function formatLastSeen(sec: number | null): string {
  if (sec === null) return "—";
  return new Date(sec * 1000).toLocaleString();
}

const DNS_STATUS_LABEL: Record<DnsProvisionOutcome["status"], string> = {
  created: "DNS record created",
  updated: "DNS record updated",
  unchanged: "DNS already correct",
  skipped: "Zone not in this Cloudflare account",
  permission_denied: "API token missing Zone:Read or DNS:Edit",
  error: "DNS provisioning failed",
};

function DnsResultBanner({ outcomes }: { outcomes: DnsProvisionOutcome[] }) {
  const hasFailure = outcomes.some(
    (o) => o.status === "skipped" || o.status === "permission_denied" || o.status === "error",
  );
  return (
    <div
      className={hasFailure ? "dns-banner dns-banner-warn" : "dns-banner dns-banner-ok"}
      role={hasFailure ? "alert" : "status"}
    >
      <strong>{hasFailure ? "Ingress saved, but DNS not fully provisioned" : "DNS routes provisioned"}</strong>
      <ul className="dns-list">
        {outcomes.map((o) => (
          <li key={o.hostname}>
            <code>{o.hostname}</code> — {DNS_STATUS_LABEL[o.status]}
            {o.error && o.status !== "created" && o.status !== "updated" && o.status !== "unchanged"
              ? `: ${o.error}`
              : null}
          </li>
        ))}
      </ul>
      {hasFailure ? (
        <p className="muted small">
          Mint a token at{" "}
          <a
            href="https://dash.cloudflare.com/profile/api-tokens"
            target="_blank"
            rel="noreferrer"
          >
            dash.cloudflare.com/profile/api-tokens
          </a>{" "}
          with <em>Account → Cloudflare Tunnel:Edit</em>, <em>Zone → Zone:Read</em>, and{" "}
          <em>Zone → DNS:Edit</em>, then run{" "}
          <code>cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN</code> and re-save.
        </p>
      ) : null}
    </div>
  );
}

export function NodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [dnsResults, setDnsResults] = useState<DnsProvisionOutcome[]>([]);

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
    const res = await putIngress(id, ingress);
    setDnsResults(res.dns ?? []);
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
              {dnsResults.length > 0 ? (
                <DnsResultBanner outcomes={dnsResults} />
              ) : null}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
