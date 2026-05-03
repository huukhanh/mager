import type { Context } from "hono";
import type { IngressRuleEntry, NodeConfigResponseBody } from "../../../schema/api";
import { listIngressForNode } from "../db/ingress";
import { touchLastSeen, updateLastConfigHash } from "../db/nodes";
import { getIngressBlob, putIngressBlob } from "../kv/ingress";
import { getTunnelRecord } from "../kv/tunnel";
import type { HonoEnv } from "../types";

async function ingressConfigHash(rules: IngressRuleEntry[]): Promise<string> {
  const sorted = [...rules].sort((a, b) =>
    a.hostname.localeCompare(b.hostname),
  );
  const text = JSON.stringify(sorted);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function nodeConfigHandler(c: Context<HonoEnv>): Promise<Response> {
  const nodeId = c.req.param("id");
  if (!nodeId) {
    return c.json({ error: "missing_node_id" }, 400);
  }
  const db = c.env.DB;
  const kv = c.env.KV;
  const nowSec = Math.floor(Date.now() / 1000);

  let ingress = await getIngressBlob(kv, nodeId);
  if (ingress === null) {
    ingress = await listIngressForNode(db, nodeId);
    await putIngressBlob(kv, nodeId, ingress);
  }

  const tunnel = await getTunnelRecord(kv, nodeId);
  if (!tunnel) {
    return c.json({ error: "tunnel_not_provisioned" }, 503);
  }

  const configHash = await ingressConfigHash(ingress);

  await touchLastSeen(db, nodeId, nowSec);
  await updateLastConfigHash(db, nodeId, configHash, nowSec);

  const body: NodeConfigResponseBody = {
    ingress,
    tunnelToken: tunnel.tunnelToken,
    configHash,
  };
  return c.json(body);
}
