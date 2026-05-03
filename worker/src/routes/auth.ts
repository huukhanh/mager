import type { Context } from "hono";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import type { LoginResponseBody } from "../../../schema/api";
import { consumeLoginRateLimit } from "../kv/rate-limit";
import type { HonoEnv } from "../types";
import { getClientIp } from "../util/client-ip";

export async function loginHandler(c: Context<HonoEnv>): Promise<Response> {
  let body: { password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    return c.json({ error: "password_required" }, 400);
  }

  const ip = getClientIp(c);
  const rl = await consumeLoginRateLimit(c.env.KV, ip);
  if (!rl.ok) {
    c.header("Retry-After", String(rl.retryAfterSec));
    return c.json({ error: "rate_limited" }, 429);
  }

  const hash = await c.env.KV.get("auth:password", "text");
  if (!hash || !bcrypt.compareSync(password, hash)) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + 8 * 3600;
  const adminToken = await sign({ adm: true, exp }, c.env.SESSION_SECRET, "HS256");
  const res: LoginResponseBody = { adminToken };
  return c.json(res);
}
