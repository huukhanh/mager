import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import { getNodeDetailHandler } from "../../src/routes/nodes-detail";
import type { HonoEnv } from "../../src/types";
import * as nodes from "../../src/db/nodes";
import * as ingressDb from "../../src/db/ingress";
import * as ingressKv from "../../src/kv/ingress";

vi.mock("../../src/db/nodes", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/db/nodes")>();
  return { ...actual, getNode: vi.fn() };
});

vi.mock("../../src/db/ingress", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/db/ingress")>();
  return { ...actual, listIngressForNode: vi.fn() };
});

vi.mock("../../src/kv/ingress", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/kv/ingress")>();
  return { ...actual, getIngressBlob: vi.fn(), putIngressBlob: vi.fn() };
});

function mockCtx(env: HonoEnv["Bindings"], id: string): Context<HonoEnv> {
  return {
    env,
    req: {
      param: (name: string) => (name === "id" ? id : ""),
    },
    json: (obj: unknown, status?: number) =>
      Response.json(obj, { status: status ?? 200 }),
  } as unknown as Context<HonoEnv>;
}

describe("getNodeDetailHandler", () => {
  beforeEach(() => {
    vi.mocked(nodes.getNode).mockReset();
    vi.mocked(ingressDb.listIngressForNode).mockReset();
    vi.mocked(ingressKv.getIngressBlob).mockReset();
    vi.mocked(ingressKv.putIngressBlob).mockReset();
  });

  it("404 when missing", async () => {
    vi.mocked(nodes.getNode).mockResolvedValue(null);
    const env = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      SESSION_SECRET: "s",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_API_TOKEN: "t",
    };
    const res = await getNodeDetailHandler(mockCtx(env, "x"));
    expect(res.status).toBe(404);
  });

  it("returns ingress from KV when present", async () => {
    vi.mocked(nodes.getNode).mockResolvedValue({
      id: "n1",
      name: "edge",
      registered_at: 1,
      last_seen: Math.floor(Date.now() / 1000),
      last_config_hash: null,
      last_applied_at: null,
      status: "online",
    });
    vi.mocked(ingressKv.getIngressBlob).mockResolvedValue([
      { hostname: "a.example.com", service: "http://localhost:1" },
    ]);

    const env = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      SESSION_SECRET: "s",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_API_TOKEN: "t",
    };

    const res = await getNodeDetailHandler(mockCtx(env, "n1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ingress: unknown[]; tunnelHostname: string | null };
    expect(json.ingress).toHaveLength(1);
    expect(json.tunnelHostname).toBe("a.example.com");
    expect(ingressDb.listIngressForNode).not.toHaveBeenCalled();
  });
});
