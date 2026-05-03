import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import type { HonoEnv } from "../types";

/** HS256 JWT minted by POST /api/auth/login — payload `{ adm: true, exp }` signed with SESSION_SECRET. */
export const adminJwtAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const hdr = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(hdr.trim());
  if (!m?.[1]) {
    return c.json({ error: "missing_bearer_token" }, 401);
  }
  try {
    const payload = await verify(m[1], c.env.SESSION_SECRET, "HS256");
    const adm =
      typeof payload === "object" &&
      payload !== null &&
      "adm" in payload &&
      (payload as { adm?: unknown }).adm === true;
    if (!adm) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }
};
