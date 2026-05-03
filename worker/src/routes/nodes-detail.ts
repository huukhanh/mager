import type { Context } from "hono";
import type { NodeDetailResponseBody } from "../../../schema/api";
import { listIngressForNode } from "../db/ingress";
import { getNode } from "../db/nodes";
import { getIngressBlob, putIngressBlob } from "../kv/ingress";
import type { HonoEnv } from "../types";
import { computeNodeStatus } from "../util/liveness";

export async function getNodeDetailHandler(c: Context<HonoEnv>): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "missing_node_id" }, 400);
  }

  const row = await getNode(c.env.DB, id);
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  let ingress = await getIngressBlob(c.env.KV, id);
  if (ingress === null) {
    ingress = await listIngressForNode(c.env.DB, id);
    await putIngressBlob(c.env.KV, id, ingress);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const tunnelHostname = ingress[0]?.hostname ?? null;

  const body: NodeDetailResponseBody = {
    id: row.id,
    name: row.name,
    status: computeNodeStatus(row.last_seen, nowSec),
    lastSeen: row.last_seen,
    tunnelHostname,
    ingress,
  };
  return c.json(body);
}
