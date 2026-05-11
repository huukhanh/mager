import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import app from "../../src/index";

const baseEnv = {
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  SESSION_SECRET: "secret-secret-secret-secret-secret-se",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_API_TOKEN: "tok",
};

describe("GET /install.sh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("serves the embedded install script by default", async () => {
    // A `fetch` call here would mean the route hit the network — which is
    // exactly the bug we're guarding against (private-repo raw.github 404).
    const fetchSpy = vi.fn(async () => new Response("SHOULD NOT BE CALLED"));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.fetch(
      new Request("http://localhost/install.sh"),
      baseEnv,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(text).toContain("Mager — agent installer");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honors INSTALL_SCRIPT_SRC_URL override", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("#!/usr/bin/env bash\necho override-ok\n")),
    );

    const res = await app.fetch(
      new Request("http://localhost/install.sh"),
      { ...baseEnv, INSTALL_SCRIPT_SRC_URL: "https://example.test/install.sh" },
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("override-ok");
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it("propagates upstream 4xx as 502 when override is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );

    const res = await app.fetch(
      new Request("http://localhost/install.sh"),
      { ...baseEnv, INSTALL_SCRIPT_SRC_URL: "https://example.test/install.sh" },
      {} as ExecutionContext,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; status: number };
    expect(body.error).toBe("upstream_http");
    expect(body.status).toBe(404);
  });
});
