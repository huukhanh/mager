import type { Context } from "hono";
import type { HonoEnv } from "../types";

/** Best-effort client IP for abuse controls (Worker / proxied dev). */
export function getClientIp(c: Context<HonoEnv>): string {
  const cf = c.req.header("CF-Connecting-IP")?.trim();
  if (cf) return cf;
  const xff = c.req.header("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}
