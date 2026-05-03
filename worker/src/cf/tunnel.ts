/**
 * Cloudflare Zero Trust — Named Tunnel provisioning (extend here for delete/revoke in M4).
 * Uses REST: POST /accounts/:account_id/cfd_tunnel and GET .../cfd_tunnel/:id/token when needed.
 */

import type { TunnelKvRecord } from "../types";

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

async function findTunnelIdByName(
  accountId: string,
  apiToken: string,
  tunnelName: string,
): Promise<string | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`;
  const parsed = await cfFetchJson<unknown>(url, apiToken, { method: "GET" });
  if (!parsed.ok) return null;
  if (!parsed.json.success) return null;
  const tunnels = normalizeTunnelList(parsed.json.result);
  const hit = tunnels.find((t) => t.name === tunnelName && !t.deleted_at);
  return hit?.id ?? null;
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
      config_src: "cloudflare",
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
    const tunnelId = await findTunnelIdByName(accountId, apiToken, tunnelName);
    if (!tunnelId) throw e;
    const tunnelToken = await fetchTunnelToken(accountId, apiToken, tunnelId);
    return {
      tunnelId,
      tunnelToken,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }
}
