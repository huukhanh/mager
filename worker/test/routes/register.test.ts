import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import { registerHandler } from "../../src/routes/register";
import type { HonoEnv } from "../../src/types";
import * as nodes from "../../src/db/nodes";
import * as audit from "../../src/db/audit";
import * as kvm from "../../src/kv/tunnel";
import * as ingressKv from "../../src/kv/ingress";
import * as ingressDb from "../../src/db/ingress";
import * as cf from "../../src/cf/tunnel";

vi.mock("../../src/db/nodes", () => ({
  getNode: vi.fn(),
  upsertNode: vi.fn(),
}));

vi.mock("../../src/db/audit", () => ({
  insertAudit: vi.fn(),
}));

vi.mock("../../src/kv/tunnel", () => ({
  getTunnelRecord: vi.fn(),
  putTunnelRecord: vi.fn(),
}));

vi.mock("../../src/kv/ingress", () => ({
  getIngressBlob: vi.fn(),
  putIngressBlob: vi.fn(),
}));

vi.mock("../../src/db/ingress", () => ({
  listIngressForNode: vi.fn(),
}));

vi.mock("../../src/cf/tunnel", () => ({
  ensureTunnelCredentials: vi.fn(),
  ensureTunnelConfigSrcLocal: vi.fn(),
}));

function mockEnv(): HonoEnv["Bindings"] {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    SESSION_SECRET: "unit-test-session-secret-32chars!",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_API_TOKEN: "tok",
  };
}

function mockRegisterContext(
  env: HonoEnv["Bindings"],
  body: unknown,
): Context<HonoEnv> {
  return {
    env,
    req: {
      json: async () => body,
    },
    json: (obj: unknown, status?: number) =>
      Response.json(obj, { status: status ?? 200 }),
  } as unknown as Context<HonoEnv>;
}

describe("registerHandler", () => {
  beforeEach(() => {
    vi.mocked(nodes.getNode).mockReset();
    vi.mocked(nodes.upsertNode).mockReset();
    vi.mocked(audit.insertAudit).mockReset();
    vi.mocked(kvm.getTunnelRecord).mockReset();
    vi.mocked(kvm.putTunnelRecord).mockReset();
    vi.mocked(ingressKv.getIngressBlob).mockReset();
    vi.mocked(ingressKv.putIngressBlob).mockReset();
    vi.mocked(ingressDb.listIngressForNode).mockReset();
    vi.mocked(cf.ensureTunnelCredentials).mockReset();
    vi.mocked(cf.ensureTunnelConfigSrcLocal).mockReset();
  });

  it("returns session token and provisions tunnel when new", async () => {
    vi.mocked(nodes.getNode).mockResolvedValue(null);
    vi.mocked(kvm.getTunnelRecord).mockResolvedValue(null);
    vi.mocked(cf.ensureTunnelCredentials).mockResolvedValue({
      tunnelId: "tid",
      tunnelToken: "ttok",
      createdAt: 1,
    });
    vi.mocked(ingressKv.getIngressBlob).mockResolvedValue(null);
    vi.mocked(ingressDb.listIngressForNode).mockResolvedValue([]);

    const env = mockEnv();
    const c = mockRegisterContext(env, {
      nodeId: "11111111-1111-4111-8111-111111111111",
      machineName: "edge-a",
    });

    const res = await registerHandler(c);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      sessionToken: string;
      nodeId: string;
      machineName: string;
    };
    expect(json.nodeId).toBe("11111111-1111-4111-8111-111111111111");
    expect(json.machineName).toBe("edge-a");
    expect(typeof json.sessionToken).toBe("string");
    expect(json.sessionToken.length).toBeGreaterThan(10);

    expect(cf.ensureTunnelCredentials).toHaveBeenCalledOnce();
    expect(kvm.putTunnelRecord).toHaveBeenCalledOnce();
    expect(ingressKv.putIngressBlob).toHaveBeenCalled();
    expect(audit.insertAudit).toHaveBeenCalled();
  });

  it("is idempotent when tunnel already in KV", async () => {
    vi.mocked(nodes.getNode).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      name: "edge-a",
      registered_at: 100,
      last_seen: null,
      last_config_hash: null,
      last_applied_at: null,
      status: "unknown",
    });
    vi.mocked(kvm.getTunnelRecord).mockResolvedValue({
      tunnelId: "tid",
      tunnelToken: "ttok",
      createdAt: 100,
    });
    vi.mocked(ingressKv.getIngressBlob).mockResolvedValue([]);

    const env = mockEnv();
    const c = mockRegisterContext(env, {
      nodeId: "11111111-1111-4111-8111-111111111111",
      machineName: "edge-a",
    });

    const res = await registerHandler(c);
    expect(res.status).toBe(200);
    expect(cf.ensureTunnelCredentials).not.toHaveBeenCalled();
    expect(kvm.putTunnelRecord).not.toHaveBeenCalled();
    // Re-registration should still attempt to migrate the tunnel's config_src to "local".
    expect(cf.ensureTunnelConfigSrcLocal).toHaveBeenCalledOnce();
  });

  it("validates body", async () => {
    const env = mockEnv();
    const c = mockRegisterContext(env, { nodeId: "", machineName: "x" });
    const res = await registerHandler(c);
    expect(res.status).toBe(400);
  });
});
