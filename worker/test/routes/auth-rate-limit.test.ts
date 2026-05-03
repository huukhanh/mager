import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import app from "../../src/index";
import { memoryKv, noopDb } from "../helpers/mocks";

describe("POST /api/auth/login rate limit", () => {
  beforeEach(() => {
    vi.spyOn(bcrypt, "compareSync").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 429 after too many attempts from the same IP", async () => {
    const secret =
      "login-secret-login-secret-login-secret-login-secret-login-secret";
    const hash = bcrypt.hashSync("any", 8);
    const kv = memoryKv({ "auth:password": hash });
    const env = {
      DB: noopDb(),
      KV: kv,
      SESSION_SECRET: secret,
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };

    const hdr = {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "198.51.100.21",
    };

    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: hdr,
          body: JSON.stringify({ password: "wrong" }),
        }),
        env,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(401);
    }

    const limited = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ password: "wrong" }),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    const json = (await limited.json()) as { error?: string };
    expect(json.error).toBe("rate_limited");
  });
});
