import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import type { HonoEnv } from "../types";

export const nodeSessionAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const nodeId = c.req.param("id");
  if (!nodeId) {
    return c.json({ error: "missing_node_id" }, 400);
  }
  const hdr = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(hdr.trim());
  if (!m?.[1]) {
    return c.json({ error: "missing_bearer_token" }, 401);
  }
  try {
    const payload = await verify(m[1], c.env.SESSION_SECRET, "HS256");
    const sub =
      typeof payload === "object" && payload !== null && "sub" in payload
        ? String((payload as { sub?: unknown }).sub ?? "")
        : "";
    if (!sub || sub !== nodeId) {
      return c.json({ error: "token_node_mismatch" }, 403);
    }
    await next();
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }
};
