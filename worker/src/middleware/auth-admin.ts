import type { Context } from "hono";
import type { HonoEnv } from "../types";

/**
 * Validates admin JWT — stub for M1 (dashboard routes land in M3).
 * Wire real verification when GET /api/nodes and ingress admin routes ship.
 */
export async function requireAdminJWT(_c: Context<HonoEnv>): Promise<void> {
  void _c;
}
