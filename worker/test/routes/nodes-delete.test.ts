import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import { deleteNodeHandler } from "../../src/routes/nodes-delete";
import type { HonoEnv } from "../../src/types";
import * as cf from "../../src/cf/tunnel";
import { memoryKv, seedTunnelKv } from "../helpers/mocks";

vi.mock("../../src/cf/tunnel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cf/tunnel")>();
  return { ...actual, deleteNamedTunnel: vi.fn(async () => {}) };
});

function dbForDelete(firstRow: Record<string, unknown> | null): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true }),
        first: async () => firstRow,
        all: async () => ({ results: [] }),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }),
  } as unknown as D1Database;
}

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

describe("deleteNodeHandler", () => {
  beforeEach(() => {
    vi.mocked(cf.deleteNamedTunnel).mockClear();
  });

  it("404 when node missing", async () => {
    const env = {
      DB: dbForDelete(null),
      KV: memoryKv(),
      SESSION_SECRET: "s",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };
    const res = await deleteNodeHandler(mockCtx(env, "missing"));
    expect(res.status).toBe(404);
    expect(cf.deleteNamedTunnel).not.toHaveBeenCalled();
  });

  it("deletes tunnel via CF then clears KV + D1", async () => {
    const kv = memoryKv();
    await seedTunnelKv(kv, "n1", {
      tunnelId: "tid-1",
      tunnelToken: "tok",
      createdAt: 1,
    });

    const row = {
      id: "n1",
      name: "edge",
      registered_at: 1,
      last_seen: null,
      last_config_hash: null,
      last_applied_at: null,
      status: "unknown",
    };

    const env = {
      DB: dbForDelete(row),
      KV: kv,
      SESSION_SECRET: "s",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "apitok",
    };

    const res = await deleteNodeHandler(mockCtx(env, "n1"));
    expect(res.status).toBe(200);
    expect(cf.deleteNamedTunnel).toHaveBeenCalledWith(
      "acct",
      "apitok",
      "tid-1",
    );
  });
});
