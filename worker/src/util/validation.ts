import type { IngressRuleEntry } from "../../../schema/api";

/** Hostnames + optional leading `*.` wildcard label (Cloudflare-style). */
const HOSTNAME_RE =
  /^(\*\.)?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  return HOSTNAME_RE.test(hostname);
}

export function isValidService(service: string): boolean {
  const s = service.trim();
  if (!s) return false;
  if (/^ssh:\/\/.+/i.test(s)) return true;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateIngressRules(
  rules: unknown,
): rules is IngressRuleEntry[] {
  if (!Array.isArray(rules)) return false;
  for (const r of rules) {
    if (!r || typeof r !== "object") return false;
    const entry = r as Record<string, unknown>;
    const hostname =
      typeof entry.hostname === "string" ? entry.hostname.trim() : "";
    const svc = typeof entry.service === "string" ? entry.service.trim() : "";
    if (!isValidHostname(hostname) || !isValidService(svc)) return false;
  }
  return true;
}
