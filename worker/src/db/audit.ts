export async function insertAudit(
  db: D1Database,
  params: {
    nodeId: string | null;
    action: string;
    detail: string | null;
    actor: string | null;
    createdAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (node_id, action, detail, actor, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      params.nodeId,
      params.action,
      params.detail,
      params.actor,
      params.createdAt,
    )
    .run();
}
