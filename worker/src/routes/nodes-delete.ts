import type { Context } from "hono";
import { deleteNamedTunnel } from "../cf/tunnel";
import { insertAudit } from "../db/audit";
import { deleteAllIngressForNode } from "../db/ingress";
import { deleteNodeRow, getNode } from "../db/nodes";
import { deleteTunnelRecord, getTunnelRecord } from "../kv/tunnel";
import { deleteIngressBlob } from "../kv/ingress";
import type { HonoEnv } from "../types";

export async function deleteNodeHandler(c: Context<HonoEnv>): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "missing_node_id" }, 400);
  }

  const existing = await getNode(c.env.DB, id);
  if (!existing) {
    return c.json({ error: "not_found" }, 404);
  }

  const tunnel = await getTunnelRecord(c.env.KV, id);
  if (tunnel?.tunnelId) {
    try {
      await deleteNamedTunnel(
        c.env.CLOUDFLARE_ACCOUNT_ID,
        c.env.CLOUDFLARE_API_TOKEN,
        tunnel.tunnelId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: "tunnel_delete_failed", detail: msg }, 502);
    }
  }

  await deleteTunnelRecord(c.env.KV, id);
  await deleteIngressBlob(c.env.KV, id);
  await deleteAllIngressForNode(c.env.DB, id);
  await deleteNodeRow(c.env.DB, id);

  const nowSec = Math.floor(Date.now() / 1000);
  await insertAudit(c.env.DB, {
    nodeId: id,
    action: "delete_node",
    detail: JSON.stringify({ name: existing.name }),
    actor: "admin",
    createdAt: nowSec,
  });

  return c.json({ ok: true });
}
