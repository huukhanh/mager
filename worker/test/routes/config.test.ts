import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import { nodeConfigHandler } from "../../src/routes/config";
import type { HonoEnv } from "../../src/types";
import * as nodes from "../../src/db/nodes";
import * as kvm from "../../src/kv/tunnel";
import * as ingressKv from "../../src/kv/ingress";
import * as ingressDb from "../../src/db/ingress";

vi.mock("../../src/db/nodes", () => ({
  touchLastSeen: vi.fn(),
  updateLastConfigHash: vi.fn(),
}));

vi.mock("../../src/kv/tunnel", () => ({
  getTunnelRecord: vi.fn(),
}));

vi.mock("../../src/kv/ingress", () => ({
  getIngressBlob: vi.fn(),
  putIngressBlob: vi.fn(),
}));

vi.mock("../../src/db/ingress", () => ({
  listIngressForNode: vi.fn(),
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

function mockConfigContext(
  env: HonoEnv["Bindings"],
  nodeId: string,
): Context<HonoEnv> {
  return {
    env,
    req: {
      param: (name: string) => (name === "id" ? nodeId : ""),
    },
    json: (obj: unknown, status?: number) =>
      Response.json(obj, { status: status ?? 200 }),
  } as unknown as Context<HonoEnv>;
}

describe("nodeConfigHandler", () => {
  beforeEach(() => {
    vi.mocked(nodes.touchLastSeen).mockReset();
    vi.mocked(nodes.updateLastConfigHash).mockReset();
    vi.mocked(kvm.getTunnelRecord).mockReset();
    vi.mocked(ingressKv.getIngressBlob).mockReset();
    vi.mocked(ingressKv.putIngressBlob).mockReset();
    vi.mocked(ingressDb.listIngressForNode).mockReset();
  });

  it("returns ingress, tunnel token, and hash", async () => {
    vi.mocked(ingressKv.getIngressBlob).mockResolvedValue([
      { hostname: "a.example.com", service: "http://localhost:3000" },
    ]);
    vi.mocked(kvm.getTunnelRecord).mockResolvedValue({
      tunnelId: "tid",
      tunnelToken: "ttok",
      createdAt: 1,
    });

    const env = mockEnv();
    const c = mockConfigContext(env, "11111111-1111-4111-8111-111111111111");
    const res = await nodeConfigHandler(c);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      tunnelId: string;
      tunnelToken: string;
      configHash: string;
      ingress: { hostname: string; service: string }[];
    };
    expect(json.tunnelId).toBe("tid");
    expect(json.tunnelToken).toBe("ttok");
    expect(json.ingress).toHaveLength(1);
    expect(json.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(nodes.touchLastSeen).toHaveBeenCalledOnce();
    expect(nodes.updateLastConfigHash).toHaveBeenCalledOnce();
  });

  it("503 when tunnel missing", async () => {
    vi.mocked(ingressKv.getIngressBlob).mockResolvedValue([]);
    vi.mocked(kvm.getTunnelRecord).mockResolvedValue(null);

    const env = mockEnv();
    const c = mockConfigContext(env, "11111111-1111-4111-8111-111111111111");
    const res = await nodeConfigHandler(c);
    expect(res.status).toBe(503);
    expect(nodes.touchLastSeen).not.toHaveBeenCalled();
  });

  it("hydrates KV from D1 when KV missing", async () => {
    vi.mocked(ingressKv.getIngressBlob).mockResolvedValue(null);
    vi.mocked(ingressDb.listIngressForNode).mockResolvedValue([
      { hostname: "b.example.com", service: "ssh://localhost:22" },
    ]);
    vi.mocked(kvm.getTunnelRecord).mockResolvedValue({
      tunnelId: "tid",
      tunnelToken: "ttok",
      createdAt: 1,
    });

    const env = mockEnv();
    const c = mockConfigContext(env, "11111111-1111-4111-8111-111111111111");
    const res = await nodeConfigHandler(c);
    expect(res.status).toBe(200);
    expect(ingressKv.putIngressBlob).toHaveBeenCalledOnce();
  });
});
