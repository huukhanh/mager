import { useEffect, useState } from "react";
import type { IngressRuleEntry } from "../types";

function emptyRule(): IngressRuleEntry {
  return { hostname: "", service: "" };
}

export function IngressEditor(props: {
  initial: IngressRuleEntry[];
  disabled?: boolean;
  onSave: (rules: IngressRuleEntry[]) => Promise<void>;
}) {
  const [rules, setRules] = useState<IngressRuleEntry[]>(() =>
    props.initial.length ? props.initial.map((r) => ({ ...r })) : [emptyRule()],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRules(
      props.initial.length ? props.initial.map((r) => ({ ...r })) : [emptyRule()],
    );
    setError(null);
  }, [props.initial]);

  function updateRow(i: number, field: keyof IngressRuleEntry, value: string) {
    setRules((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value };
      return next;
    });
  }

  function addRow() {
    setRules((prev) => [...prev, emptyRule()]);
  }

  function removeRow(i: number) {
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const cleaned = rules
        .map((r) => ({
          hostname: r.hostname.trim(),
          service: r.service.trim(),
        }))
        .filter((r) => r.hostname.length > 0 || r.service.length > 0);
      await props.onSave(cleaned);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ingress-editor">
      <div className="ingress-head">
        <h2>Ingress</h2>
        <div className="ingress-actions">
          <button type="button" className="btn ghost" onClick={addRow} disabled={props.disabled}>
            Add row
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={props.disabled || saving}>
            {saving ? "Saving…" : "Save ingress"}
          </button>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="ingress-rows">
        <div className="ingress-row ingress-row-head">
          <span>Hostname</span>
          <span>Service</span>
          <span />
        </div>
        {rules.map((r, i) => (
          <div className="ingress-row" key={i}>
            <input
              className="input"
              value={r.hostname}
              placeholder="app.example.com"
              onChange={(ev) => updateRow(i, "hostname", ev.target.value)}
              disabled={props.disabled}
            />
            <input
              className="input mono"
              value={r.service}
              placeholder="http://localhost:3000"
              onChange={(ev) => updateRow(i, "service", ev.target.value)}
              disabled={props.disabled}
            />
            <button
              type="button"
              className="btn danger ghost"
              onClick={() => removeRow(i)}
              disabled={props.disabled || rules.length <= 1}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <p className="muted small">
        Allowed: DNS hostnames and <code>http(s)://</code> or <code>ssh://</code> targets (validated by the API).
      </p>
    </div>
  );
}
