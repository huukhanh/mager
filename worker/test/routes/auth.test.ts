import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import app from "../../src/index";
import { memoryKv, noopDb } from "../helpers/mocks";

describe("POST /api/auth/login", () => {
  it("returns admin JWT when password matches KV hash", async () => {
    const secret =
      "login-secret-login-secret-login-secret-login-secret-login-secret";
    const hash = bcrypt.hashSync("correct", 8);
    const kv = memoryKv({ "auth:password": hash });
    const env = {
      DB: noopDb(),
      KV: kv,
      SESSION_SECRET: secret,
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };

    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct" }),
    });

    const res = await app.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { adminToken?: string };
    expect(json.adminToken).toBeTruthy();
  });

  it("rejects wrong password", async () => {
    const secret =
      "login-secret-login-secret-login-secret-login-secret-login-secret";
    const hash = bcrypt.hashSync("correct", 8);
    const kv = memoryKv({ "auth:password": hash });
    const env = {
      DB: noopDb(),
      KV: kv,
      SESSION_SECRET: secret,
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    };

    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });

    const res = await app.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
