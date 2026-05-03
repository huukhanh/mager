import type { IngressRuleEntry } from "../../../schema/api";

export async function listIngressForNode(
  db: D1Database,
  nodeId: string,
): Promise<IngressRuleEntry[]> {
  const rows = await db
    .prepare(
      `SELECT hostname, service FROM ingress_rules WHERE node_id = ? ORDER BY hostname`,
    )
    .bind(nodeId)
    .all<{ hostname: string; service: string }>();
  return (rows.results ?? []).map((r) => ({
    hostname: r.hostname,
    service: r.service,
  }));
}
