import { describe, expect, it } from "vitest";
import app from "../../src/index";

const baseEnv = {
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  SESSION_SECRET: "secret-secret-secret-secret-secret-se",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_API_TOKEN: "tok",
};

describe("GET /agent/linux-:arch", () => {
  it("redirects amd64 to GitHub release latest", async () => {
    const res = await app.fetch(
      new Request("http://localhost/agent/linux-amd64", { redirect: "manual" }),
      baseEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://github.com/huukhanh/mager/releases/latest/download/mager-agent-linux-amd64",
    );
  });

  it("redirects arm64 to GitHub release latest", async () => {
    const res = await app.fetch(
      new Request("http://localhost/agent/linux-arm64", { redirect: "manual" }),
      baseEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://github.com/huukhanh/mager/releases/latest/download/mager-agent-linux-arm64",
    );
  });

  it("rejects unsupported architectures with 404", async () => {
    const res = await app.fetch(
      new Request("http://localhost/agent/linux-i386", { redirect: "manual" }),
      baseEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("honors AGENT_RELEASE_REPO + AGENT_RELEASE_TAG overrides", async () => {
    const env = {
      ...baseEnv,
      AGENT_RELEASE_REPO: "myorg/myrepo",
      AGENT_RELEASE_TAG: "v0.2.0",
    };
    const res = await app.fetch(
      new Request("http://localhost/agent/linux-amd64", { redirect: "manual" }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://github.com/myorg/myrepo/releases/download/v0.2.0/mager-agent-linux-amd64",
    );
  });
});
