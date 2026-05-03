import type { IngressRuleEntry, NodeDetail, NodeSummary } from "../types";

const TOKEN_KEY = "cloudtunnel_admin_token";

let warnedBadBase = false;
function apiBase(): string {
  const v = import.meta.env.VITE_API_BASE_URL;
  if (typeof v !== "string" || v.trim().length === 0) {
    return "";
  }
  const trimmed = v.trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    if (!warnedBadBase) {
      warnedBadBase = true;
      console.error(
        `[cloudtunnel] VITE_API_BASE_URL is not a full URL: ${JSON.stringify(trimmed)}. ` +
          `It must start with http:// or https:// (e.g. https://<worker>.<subdomain>.workers.dev). ` +
          `Rebuild the dashboard with a valid value or unset it to use a same-origin proxy.`,
      );
    }
    return "";
  }
  return trimmed;
}

export function getAdminToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setAdminToken(token: string | null): void {
  if (token === null) {
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
  }
}

export function logout(): void {
  setAdminToken(null);
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = apiBase();
  const url = `${base}${path}`;
  const headers = new Headers(init?.headers);
  const token = getAdminToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { ...init, headers });
  const body = await parseJson<unknown>(res).catch(() => null);

  if (!res.ok) {
    const msg =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, body);
  }

  return body as T;
}

export async function login(password: string): Promise<void> {
  setAdminToken(null);
  const json = await apiFetch<{ adminToken: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  setAdminToken(json.adminToken);
}

export async function fetchNodes(): Promise<{ nodes: NodeSummary[] }> {
  return apiFetch("/api/nodes");
}

export async function fetchNodeDetail(id: string): Promise<NodeDetail> {
  return apiFetch(`/api/nodes/${encodeURIComponent(id)}`);
}

export async function patchNodeName(id: string, name: string): Promise<void> {
  await apiFetch(`/api/nodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function putIngress(
  id: string,
  ingress: IngressRuleEntry[],
): Promise<void> {
  await apiFetch(`/api/nodes/${encodeURIComponent(id)}/ingress`, {
    method: "PUT",
    body: JSON.stringify({ ingress }),
  });
}

export async function deleteNode(id: string): Promise<void> {
  await apiFetch(`/api/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
