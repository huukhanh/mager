import { describe, it, expect, vi, beforeEach } from "vitest";
import { sign } from "hono/jwt";
import app from "../../src/index";
import { noopDb } from "../helpers/mocks";

vi.mock("../../src/db/nodes", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/db/nodes")>();
  return { ...actual, listNodes: vi.fn() };
});

vi.mock("../../src/db/ingress", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/db/ingress")>();
  return { ...actual, listIngressForNode: vi.fn() };
});

import * as nodes from "../../src/db/nodes";
import * as ingress from "../../src/db/ingress";

describe("GET /api/nodes", () => {
  beforeEach(() => {
    vi.mocked(nodes.listNodes).mockReset();
    vi.mocked(ingress.listIngressForNode).mockReset();
  });

  it("requires admin bearer token", async () => {
    const env = {
      DB: noopDb(),
      KV: {} as KVNamespace,
      SESSION_SECRET: "adm-secret-adm-secret-adm-secret-adm-secret-adm",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };
    const req = new Request("http://localhost/api/nodes");
    const res = await app.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it("lists nodes with derived status", async () => {
    const secret =
      "adm-secret-adm-secret-adm-secret-adm-secret-adm-secret-adm";
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(nodes.listNodes).mockResolvedValue([
      {
        id: "n1",
        name: "edge-a",
        registered_at: nowSec - 1000,
        last_seen: nowSec - 10,
        last_config_hash: null,
        last_applied_at: null,
        status: "online",
      },
    ]);
    vi.mocked(ingress.listIngressForNode).mockResolvedValue([
      { hostname: "app.example.com", service: "http://localhost:3000" },
    ]);

    const exp = nowSec + 3600;
    const token = await sign({ adm: true, exp }, secret, "HS256");

    const env = {
      DB: noopDb(),
      KV: {} as KVNamespace,
      SESSION_SECRET: secret,
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };

    const req = new Request("http://localhost/api/nodes", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const res = await app.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      nodes: {
        id: string;
        status: string;
        tunnelHostname: string | null;
      }[];
    };
    expect(json.nodes).toHaveLength(1);
    expect(json.nodes[0].id).toBe("n1");
    expect(json.nodes[0].status).toBe("online");
    expect(json.nodes[0].tunnelHostname).toBe("app.example.com");
  });
});
