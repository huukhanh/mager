import type { Context } from "hono";
import type { NodeSummary, NodesListResponseBody } from "../../../schema/api";
import { listIngressForNode } from "../db/ingress";
import { listNodes } from "../db/nodes";
import type { HonoEnv } from "../types";
import { computeNodeStatus } from "../util/liveness";

export async function listNodesHandler(c: Context<HonoEnv>): Promise<Response> {
  const rows = await listNodes(c.env.DB);
  const nowSec = Math.floor(Date.now() / 1000);
  const nodes: NodeSummary[] = await Promise.all(
    rows.map(async (row) => {
      const ingress = await listIngressForNode(c.env.DB, row.id);
      const tunnelHostname = ingress[0]?.hostname ?? null;
      return {
        id: row.id,
        name: row.name,
        status: computeNodeStatus(row.last_seen, nowSec),
        lastSeen: row.last_seen,
        tunnelHostname,
      };
    }),
  );
  const body: NodesListResponseBody = { nodes };
  return c.json(body);
}
