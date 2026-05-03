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

export async function replaceIngressForNode(
  db: D1Database,
  nodeId: string,
  rules: IngressRuleEntry[],
  nowSec: number,
): Promise<void> {
  await deleteAllIngressForNode(db, nodeId);
  const stmt = db.prepare(
    `INSERT INTO ingress_rules (node_id, hostname, service, created_at) VALUES (?, ?, ?, ?)`,
  );
  for (const r of rules) {
    await stmt.bind(nodeId, r.hostname, r.service, nowSec).run();
  }
}

export async function deleteAllIngressForNode(
  db: D1Database,
  nodeId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM ingress_rules WHERE node_id = ?`)
    .bind(nodeId)
    .run();
}
