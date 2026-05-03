import { describe, it, expect, vi, beforeEach } from "vitest";
import { sign } from "hono/jwt";
import type { Context } from "hono";
import { putIngressHandler } from "../../src/routes/ingress-put";
import type { HonoEnv } from "../../src/types";
import * as nodes from "../../src/db/nodes";
import * as ingress from "../../src/db/ingress";
import * as ingressKv from "../../src/kv/ingress";
import * as kvTunnel from "../../src/kv/tunnel";
import * as audit from "../../src/db/audit";
import * as cf from "../../src/cf/tunnel";

vi.mock("../../src/db/nodes", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/db/nodes")>();
  return { ...actual, getNode: vi.fn() };
});

vi.mock("../../src/db/ingress", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/db/ingress")>();
  return { ...actual, replaceIngressForNode: vi.fn() };
});

vi.mock("../../src/kv/ingress", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/kv/ingress")>();
  return { ...actual, putIngressBlob: vi.fn() };
});

vi.mock("../../src/db/audit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/db/audit")>();
  return { ...actual, insertAudit: vi.fn() };
});

vi.mock("../../src/kv/tunnel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/kv/tunnel")>();
  return { ...actual, getTunnelRecord: vi.fn() };
});

vi.mock("../../src/cf/tunnel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cf/tunnel")>();
  return { ...actual, provisionDnsRoutes: vi.fn() };
});

function mockCtx(
  env: HonoEnv["Bindings"],
  nodeId: string,
  body: unknown,
): Context<HonoEnv> {
  return {
    env,
    req: {
      param: (name: string) => (name === "id" ? nodeId : ""),
      json: async () => body,
    },
    json: (obj: unknown, status?: number) =>
      Response.json(obj, { status: status ?? 200 }),
  } as unknown as Context<HonoEnv>;
}

describe("putIngressHandler", () => {
  beforeEach(() => {
    vi.mocked(nodes.getNode).mockReset();
    vi.mocked(ingress.replaceIngressForNode).mockReset();
    vi.mocked(ingressKv.putIngressBlob).mockReset();
    vi.mocked(audit.insertAudit).mockReset();
    vi.mocked(kvTunnel.getTunnelRecord).mockReset();
    vi.mocked(cf.provisionDnsRoutes).mockReset();
    vi.mocked(cf.provisionDnsRoutes).mockResolvedValue([]);
  });

  it("422 on invalid ingress", async () => {
    const env = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      SESSION_SECRET: "s",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_API_TOKEN: "t",
    };
    const c = mockCtx(env, "n1", {
      ingress: [{ hostname: "not a domain", service: "http://localhost:1" }],
    });
    const res = await putIngressHandler(c);
    expect(res.status).toBe(422);
  });

  it("writes KV + D1 when valid", async () => {
    vi.mocked(nodes.getNode).mockResolvedValue({
      id: "n1",
      name: "edge",
      registered_at: 1,
      last_seen: null,
      last_config_hash: null,
      last_applied_at: null,
      status: "unknown",
    });

    const env = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      SESSION_SECRET: "s",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_API_TOKEN: "t",
    };

    const c = mockCtx(env, "n1", {
      ingress: [{ hostname: "app.example.com", service: "http://127.0.0.1:80" }],
    });
    const res = await putIngressHandler(c);
    expect(res.status).toBe(200);
    expect(ingress.replaceIngressForNode).toHaveBeenCalled();
    expect(ingressKv.putIngressBlob).toHaveBeenCalled();
    expect(audit.insertAudit).toHaveBeenCalled();
  });

  it("provisions DNS for each hostname when a tunnel record exists", async () => {
    vi.mocked(nodes.getNode).mockResolvedValue({
      id: "n1",
      name: "edge",
      registered_at: 1,
      last_seen: null,
      last_config_hash: null,
      last_applied_at: null,
      status: "unknown",
    });
    vi.mocked(kvTunnel.getTunnelRecord).mockResolvedValue({
      tunnelId: "tid-1",
      tunnelToken: "ttok",
      createdAt: 1,
    });
    vi.mocked(cf.provisionDnsRoutes).mockResolvedValue([
      { hostname: "app.example.com", status: "created" },
    ]);

    const env = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      SESSION_SECRET: "s",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };
    const c = mockCtx(env, "n1", {
      ingress: [{ hostname: "app.example.com", service: "http://127.0.0.1:80" }],
    });
    const res = await putIngressHandler(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dns: { hostname: string; status: string }[] };
    expect(body.dns).toEqual([{ hostname: "app.example.com", status: "created" }]);
    expect(cf.provisionDnsRoutes).toHaveBeenCalledWith(
      "acct",
      "tok",
      "tid-1",
      ["app.example.com"],
    );
  });

  it("skips DNS provisioning when no tunnel record exists", async () => {
    vi.mocked(nodes.getNode).mockResolvedValue({
      id: "n1",
      name: "edge",
      registered_at: 1,
      last_seen: null,
      last_config_hash: null,
      last_applied_at: null,
      status: "unknown",
    });
    vi.mocked(kvTunnel.getTunnelRecord).mockResolvedValue(null);

    const env = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      SESSION_SECRET: "s",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };
    const c = mockCtx(env, "n1", {
      ingress: [{ hostname: "app.example.com", service: "http://127.0.0.1:80" }],
    });
    const res = await putIngressHandler(c);
    expect(res.status).toBe(200);
    expect(cf.provisionDnsRoutes).not.toHaveBeenCalled();
  });
});
