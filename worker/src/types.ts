/** Worker bindings + secrets (template / wrangler secrets). */

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /** Signs HS256 session JWTs for nodes (hono/jwt); minted at register, verified on GET /config. Stateless — no session row in D1 for M1. */
  SESSION_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  /** Optional override for GET /install.sh upstream (defaults to GitHub raw main). */
  INSTALL_SCRIPT_SRC_URL?: string;
}

export type HonoEnv = { Bindings: Env };

/** Stored under KV key node:{id}:tunnel */
export interface TunnelKvRecord {
  tunnelId: string;
  tunnelToken: string;
  createdAt: number;
}

export interface NodeRow {
  id: string;
  name: string;
  registered_at: number;
  last_seen: number | null;
  last_config_hash: string | null;
  last_applied_at: number | null;
  status: string | null;
}
