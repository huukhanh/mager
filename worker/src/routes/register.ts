import type { Context } from "hono";
import { sign } from "hono/jwt";
import type { RegisterRequestBody, RegisterResponseBody } from "../../../schema/api";
import { insertAudit } from "../db/audit";
import { getNode, upsertNode } from "../db/nodes";
import { listIngressForNode } from "../db/ingress";
import { ensureTunnelConfigSrcLocal, ensureTunnelCredentials } from "../cf/tunnel";
import { getIngressBlob, putIngressBlob } from "../kv/ingress";
import { getTunnelRecord, putTunnelRecord } from "../kv/tunnel";
import type { HonoEnv } from "../types";

function tunnelNameForNode(nodeId: string): string {
  return `cloudtunnel-${nodeId}`;
}

export async function registerHandler(c: Context<HonoEnv>): Promise<Response> {
  let body: RegisterRequestBody;
  try {
    body = (await c.req.json()) as RegisterRequestBody;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const nodeId = typeof body.nodeId === "string" ? body.nodeId.trim() : "";
  const machineName =
    typeof body.machineName === "string" ? body.machineName.trim() : "";

  if (!nodeId || !machineName) {
    return c.json({ error: "nodeId_and_machineName_required" }, 400);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const db = c.env.DB;
  const kv = c.env.KV;
  const prior = await getNode(db, nodeId);

  await upsertNode(db, nodeId, machineName, prior?.registered_at ?? nowSec);

  let tunnel = await getTunnelRecord(kv, nodeId);
  if (!tunnel) {
    tunnel = await ensureTunnelCredentials(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN,
      tunnelNameForNode(nodeId),
    );
    await putTunnelRecord(kv, nodeId, tunnel);
    await insertAudit(db, {
      nodeId,
      action: "tunnel_provision",
      detail: JSON.stringify({ tunnelId: tunnel.tunnelId }),
      actor: "worker",
      createdAt: nowSec,
    });
  } else {
    // Tunnel already exists in KV (re-registration). Auto-migrate any legacy tunnel
    // that was provisioned with config_src="cloudflare" so the agent's local config.yml is honored.
    await ensureTunnelConfigSrcLocal(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN,
      tunnel.tunnelId,
    );
  }

  let ingress = await getIngressBlob(kv, nodeId);
  if (ingress === null) {
    ingress = await listIngressForNode(db, nodeId);
    await putIngressBlob(kv, nodeId, ingress.length ? ingress : []);
    ingress = ingress.length ? ingress : [];
  }

  if (!prior) {
    await insertAudit(db, {
      nodeId,
      action: "register",
      detail: JSON.stringify({ machineName }),
      actor: "node",
      createdAt: nowSec,
    });
  }

  const exp = nowSec + 60 * 60 * 24 * 365;
  const sessionToken = await sign(
    { sub: nodeId, iat: nowSec, exp },
    c.env.SESSION_SECRET,
    "HS256",
  );

  const resBody: RegisterResponseBody = {
    sessionToken,
    nodeId,
    machineName,
  };
  return c.json(resBody);
}
