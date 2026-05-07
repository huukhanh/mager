import { describe, expect, it } from "vitest";
import app from "../../src/index";

const baseEnv = {
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  SESSION_SECRET: "secret-secret-secret-secret-secret-se",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_API_TOKEN: "tok",
};

describe("GET /agent/:platform", () => {
  const cases: Array<{ platform: string }> = [
    { platform: "linux-amd64" },
    { platform: "linux-arm64" },
    { platform: "darwin-amd64" },
    { platform: "darwin-arm64" },
  ];

  for (const { platform } of cases) {
    it(`redirects ${platform} to GitHub release latest`, async () => {
      const res = await app.fetch(
        new Request(`http://localhost/agent/${platform}`, {
          redirect: "manual",
        }),
        baseEnv,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        `https://github.com/huukhanh/mager/releases/latest/download/mager-agent-${platform}`,
      );
    });
  }

  it("rejects unsupported architectures with 404 and lists all supported platforms", async () => {
    const res = await app.fetch(
      new Request("http://localhost/agent/linux-i386", { redirect: "manual" }),
      baseEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { supported: string[] };
    expect(body.supported.sort()).toEqual([
      "darwin-amd64",
      "darwin-arm64",
      "linux-amd64",
      "linux-arm64",
    ]);
  });

  it("rejects unsupported OS with 404", async () => {
    const res = await app.fetch(
      new Request("http://localhost/agent/windows-amd64", {
        redirect: "manual",
      }),
      baseEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("honors AGENT_RELEASE_REPO + AGENT_RELEASE_TAG overrides on darwin", async () => {
    const env = {
      ...baseEnv,
      AGENT_RELEASE_REPO: "myorg/myrepo",
      AGENT_RELEASE_TAG: "v0.2.0",
    };
    const res = await app.fetch(
      new Request("http://localhost/agent/darwin-arm64", {
        redirect: "manual",
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://github.com/myorg/myrepo/releases/download/v0.2.0/mager-agent-darwin-arm64",
    );
  });
});
