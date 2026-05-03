/**
 * Cloudflare Zero Trust — Named Tunnel + DNS provisioning.
 * Uses REST: /accounts/:account_id/cfd_tunnel for tunnels, /zones for DNS.
 *
 * Tunnels are created with `config_src: "local"` so the agent's local config.yml
 * (written via `--config`) drives ingress. Existing tunnels created with
 * `config_src: "cloudflare"` are migrated transparently in `ensureTunnelCredentials`.
 */

import type { TunnelKvRecord } from "../types";

const CFD_TUNNEL_CARGOTUNNEL_SUFFIX = ".cfargotunnel.com";
export const TUNNEL_CONFIG_SRC_LOCAL = "local";

type CfResult<T> = {
  success: boolean;
  result?: T;
  errors?: { code?: number; message: string }[];
};

function tunnelTokenFromResult(result: Record<string, unknown>): string | null {
  const direct = result.token ?? result.Token;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const creds = result.credentials as Record<string, unknown> | undefined;
  const nested = creds?.token ?? creds?.Token;
  if (typeof nested === "string" && nested.length > 0) return nested;
  return null;
}

async function cfFetchJson<T>(
  url: string,
  apiToken: string,
  init?: RequestInit,
): Promise<{ ok: true; json: CfResult<T> } | { ok: false; status: number; text: string }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  try {
    const json = JSON.parse(text) as CfResult<T>;
    return { ok: true, json };
  } catch {
    return { ok: false, status: res.status, text };
  }
}

interface TunnelListRow {
  id: string;
  name: string;
  deleted_at?: string | null;
  config_src?: string;
}

interface TunnelDetail {
  id: string;
  name: string;
  config_src?: string;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

interface ZoneRow {
  id: string;
  name: string;
}

function normalizeTunnelList(result: unknown): TunnelListRow[] {
  if (Array.isArray(result)) return result as TunnelListRow[];
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { tunnels?: unknown }).tunnels)
  ) {
    return (result as { tunnels: TunnelListRow[] }).tunnels;
  }
  return [];
}

export async function fetchTunnelToken(
  accountId: string,
  apiToken: string,
  tunnelId: string,
): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`;
  const parsed = await cfFetchJson<string>(url, apiToken, { method: "GET" });
  if (!parsed.ok) {
    throw new Error(`Cloudflare tunnel token: invalid JSON (${parsed.status})`);
  }
  const { json } = parsed;
  if (!json.success || typeof json.result !== "string" || json.result.length === 0) {
    const msg = json.errors?.map((e) => e.message).join("; ") ?? "unknown error";
    throw new Error(`Cloudflare tunnel token failed: ${msg}`);
  }
  return json.result;
}

async function findTunnelByName(
  accountId: string,
  apiToken: string,
  tunnelName: string,
): Promise<TunnelListRow | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`;
  const parsed = await cfFetchJson<unknown>(url, apiToken, { method: "GET" });
  if (!parsed.ok) return null;
  if (!parsed.json.success) return null;
  const tunnels = normalizeTunnelList(parsed.json.result);
  return tunnels.find((t) => t.name === tunnelName && !t.deleted_at) ?? null;
}

async function findTunnelIdByName(
  accountId: string,
  apiToken: string,
  tunnelName: string,
): Promise<string | null> {
  const hit = await findTunnelByName(accountId, apiToken, tunnelName);
  return hit?.id ?? null;
}

async function getTunnel(
  accountId: string,
  apiToken: string,
  tunnelId: string,
): Promise<TunnelDetail | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
  const parsed = await cfFetchJson<TunnelDetail>(url, apiToken, { method: "GET" });
  if (!parsed.ok || !parsed.json.success || !parsed.json.result) return null;
  return parsed.json.result;
}

/**
 * PATCH the tunnel's config_src. Used to migrate tunnels originally created with
 * `config_src: "cloudflare"` to `"local"` so the agent's --config file is honored.
 */
export async function setTunnelConfigSrc(
  accountId: string,
  apiToken: string,
  tunnelId: string,
  configSrc: "local" | "cloudflare",
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
  const parsed = await cfFetchJson<unknown>(url, apiToken, {
    method: "PATCH",
    body: JSON.stringify({ config_src: configSrc }),
  });
  if (!parsed.ok) {
    throw new Error(
      `Cloudflare tunnel patch config_src failed: HTTP ${parsed.status} ${parsed.text}`,
    );
  }
  if (!parsed.json.success) {
    const msg = parsed.json.errors?.map((e) => e.message).join("; ") ?? "unknown error";
    throw new Error(`Cloudflare tunnel patch config_src failed: ${msg}`);
  }
}

export async function createNamedTunnel(
  accountId: string,
  apiToken: string,
  tunnelName: string,
): Promise<TunnelKvRecord> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`;
  const parsed = await cfFetchJson<Record<string, unknown>>(url, apiToken, {
    method: "POST",
    body: JSON.stringify({
      name: tunnelName,
      // Local config: cloudflared honors `--config /tmp/cloudtunnel-ingress-*.yml` written by the agent.
      // "cloudflare" would force ingress to be fetched from CF and silently ignore the local file.
      config_src: TUNNEL_CONFIG_SRC_LOCAL,
    }),
  });
  if (!parsed.ok) {
    throw new Error(`Cloudflare tunnel create failed: ${parsed.text}`);
  }
  const json = parsed.json;
  if (!json.success || !json.result) {
    const msg = json.errors?.map((e) => e.message).join("; ") ?? "unknown error";
    throw new Error(`Cloudflare tunnel create failed: ${msg}`);
  }
  const tunnelId = String(json.result.id ?? json.result.uuid ?? "");
  if (!tunnelId) throw new Error("Cloudflare tunnel create missing id");
  let tunnelToken = tunnelTokenFromResult(json.result);
  if (!tunnelToken) {
    tunnelToken = await fetchTunnelToken(accountId, apiToken, tunnelId);
  }
  return {
    tunnelId,
    tunnelToken,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Idempotent tunnel provisioning for POST /api/register: creates or resolves an existing tunnel name.
 * Also migrates legacy tunnels (config_src="cloudflare") to "local" so local config.yml takes effect.
 */
export async function ensureTunnelCredentials(
  accountId: string,
  apiToken: string,
  tunnelName: string,
): Promise<TunnelKvRecord> {
  try {
    return await createNamedTunnel(accountId, apiToken, tunnelName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const duplicate = /already exists|duplicate|identical request|409/i.test(msg);
    if (!duplicate) throw e;
    const existing = await findTunnelByName(accountId, apiToken, tunnelName);
    if (!existing) throw e;
    if (existing.config_src && existing.config_src !== TUNNEL_CONFIG_SRC_LOCAL) {
      try {
        await setTunnelConfigSrc(accountId, apiToken, existing.id, TUNNEL_CONFIG_SRC_LOCAL);
      } catch (patchErr) {
        // Don't block registration — log only. Operator can re-run setup or fix in dashboard.
        console.warn(
          `Tunnel ${existing.id} config_src migration to "local" failed: ${
            patchErr instanceof Error ? patchErr.message : String(patchErr)
          }`,
        );
      }
    }
    const tunnelToken = await fetchTunnelToken(accountId, apiToken, existing.id);
    return {
      tunnelId: existing.id,
      tunnelToken,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }
}

/**
 * Best-effort: fetch and migrate config_src for an already-known tunnel id.
 * Called from the register flow when KV already has tunnel creds (skips create).
 */
export async function ensureTunnelConfigSrcLocal(
  accountId: string,
  apiToken: string,
  tunnelId: string,
): Promise<void> {
  const detail = await getTunnel(accountId, apiToken, tunnelId);
  if (!detail) return;
  if (detail.config_src && detail.config_src !== TUNNEL_CONFIG_SRC_LOCAL) {
    try {
      await setTunnelConfigSrc(accountId, apiToken, tunnelId, TUNNEL_CONFIG_SRC_LOCAL);
    } catch (e) {
      console.warn(
        `Tunnel ${tunnelId} config_src migration to "local" failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

/**
 * Find the CF zone whose name is a suffix of the hostname (e.g. "savebee.xyz" zone covers
 * "awscloudshell.savebee.xyz"). Returns null if the zone is not in the operator's account.
 */
export async function findZoneIdForHostname(
  accountId: string,
  apiToken: string,
  hostname: string,
): Promise<string | null> {
  const url = `https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=50`;
  const parsed = await cfFetchJson<ZoneRow[]>(url, apiToken, { method: "GET" });
  if (!parsed.ok || !parsed.json.success || !Array.isArray(parsed.json.result)) {
    return null;
  }
  const lc = hostname.toLowerCase();
  // Prefer the longest matching zone name (handles nested zones like "a.example.com" vs "example.com").
  const zones = (parsed.json.result as ZoneRow[])
    .filter((z) => lc === z.name.toLowerCase() || lc.endsWith("." + z.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  return zones[0]?.id ?? null;
}

async function findCnameRecord(
  apiToken: string,
  zoneId: string,
  name: string,
): Promise<DnsRecord | null> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`;
  const parsed = await cfFetchJson<DnsRecord[]>(url, apiToken, { method: "GET" });
  if (!parsed.ok || !parsed.json.success || !Array.isArray(parsed.json.result)) {
    return null;
  }
  const rows = parsed.json.result as DnsRecord[];
  return rows[0] ?? null;
}

/**
 * Idempotently ensures a CNAME `<hostname>` → `<tunnel_id>.cfargotunnel.com` (proxied=true).
 * Throws on permission/network failures so callers can decide whether to surface or swallow.
 */
export async function upsertTunnelDnsRoute(
  apiToken: string,
  zoneId: string,
  hostname: string,
  tunnelId: string,
): Promise<{ created: boolean; updated: boolean; recordId: string }> {
  const target = `${tunnelId}${CFD_TUNNEL_CARGOTUNNEL_SUFFIX}`;
  const existing = await findCnameRecord(apiToken, zoneId, hostname);

  if (existing) {
    if (existing.content === target && existing.proxied === true) {
      return { created: false, updated: false, recordId: existing.id };
    }
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existing.id}`;
    const parsed = await cfFetchJson<DnsRecord>(url, apiToken, {
      method: "PATCH",
      body: JSON.stringify({ content: target, proxied: true }),
    });
    if (!parsed.ok || !parsed.json.success) {
      const msg = parsed.ok
        ? parsed.json.errors?.map((e) => e.message).join("; ") ?? "unknown error"
        : `HTTP ${parsed.status}: ${parsed.text}`;
      throw new Error(`DNS update failed for ${hostname}: ${msg}`);
    }
    return { created: false, updated: true, recordId: existing.id };
  }

  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
  const parsed = await cfFetchJson<DnsRecord>(url, apiToken, {
    method: "POST",
    body: JSON.stringify({
      type: "CNAME",
      name: hostname,
      content: target,
      proxied: true,
      comment: "Managed by CloudTunnel Manager",
    }),
  });
  if (!parsed.ok || !parsed.json.success || !parsed.json.result) {
    const msg = parsed.ok
      ? parsed.json.errors?.map((e) => e.message).join("; ") ?? "unknown error"
      : `HTTP ${parsed.status}: ${parsed.text}`;
    throw new Error(`DNS create failed for ${hostname}: ${msg}`);
  }
  return { created: true, updated: false, recordId: parsed.json.result.id };
}

export interface DnsProvisionOutcome {
  hostname: string;
  status: "created" | "updated" | "unchanged" | "skipped" | "error";
  error?: string;
}

/**
 * Best-effort DNS provisioning for all hostnames behind a tunnel.
 * Skips hostnames whose zone is not in the account; errors are captured per-hostname so a single
 * misconfigured row does not block ingress save.
 */
export async function provisionDnsRoutes(
  accountId: string,
  apiToken: string,
  tunnelId: string,
  hostnames: string[],
): Promise<DnsProvisionOutcome[]> {
  const results: DnsProvisionOutcome[] = [];
  for (const hostname of hostnames) {
    try {
      const zoneId = await findZoneIdForHostname(accountId, apiToken, hostname);
      if (!zoneId) {
        results.push({
          hostname,
          status: "skipped",
          error: "zone_not_in_account",
        });
        continue;
      }
      const r = await upsertTunnelDnsRoute(apiToken, zoneId, hostname, tunnelId);
      results.push({
        hostname,
        status: r.created ? "created" : r.updated ? "updated" : "unchanged",
      });
    } catch (e) {
      results.push({
        hostname,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

export async function deleteNamedTunnel(
  accountId: string,
  apiToken: string,
  tunnelId: string,
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
  const parsed = await cfFetchJson<{ id?: string }>(url, apiToken, {
    method: "DELETE",
  });
  if (!parsed.ok) {
    throw new Error(`Cloudflare tunnel delete failed: HTTP ${parsed.status}`);
  }
  const json = parsed.json;
  if (json.success) return;
  const msg = json.errors?.map((e) => e.message).join("; ") ?? "unknown error";
  const notFound =
    /not\s*found|HTTP\s*404|code\s*:\s*404/i.test(msg) ||
    json.errors?.some((e) => /not\s*found/i.test(e.message));
  if (notFound) return;
  throw new Error(`Cloudflare tunnel delete failed: ${msg}`);
}
