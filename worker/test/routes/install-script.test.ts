import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import app from "../../src/index";

describe("GET /install.sh", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("#!/usr/bin/env bash\necho mager-ok\n")),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns upstream install script text", async () => {
    const env = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      SESSION_SECRET: "secret-secret-secret-secret-secret-se",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };

    const res = await app.fetch(
      new Request("http://localhost/install.sh"),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("mager-ok");
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});
