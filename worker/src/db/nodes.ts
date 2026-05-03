import type { NodeRow } from "../types";

export async function getNode(
  db: D1Database,
  id: string,
): Promise<NodeRow | null> {
  const row = await db
    .prepare(`SELECT * FROM nodes WHERE id = ?`)
    .bind(id)
    .first<NodeRow>();
  return row ?? null;
}

export async function upsertNode(
  db: D1Database,
  id: string,
  name: string,
  nowSec: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO nodes (id, name, registered_at, last_seen, last_config_hash, last_applied_at, status)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'unknown')
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
    )
    .bind(id, name, nowSec)
    .run();
}

export async function touchLastSeen(
  db: D1Database,
  id: string,
  nowSec: number,
): Promise<void> {
  await db
    .prepare(`UPDATE nodes SET last_seen = ?, status = 'online' WHERE id = ?`)
    .bind(nowSec, id)
    .run();
}

export async function updateLastConfigHash(
  db: D1Database,
  id: string,
  hash: string,
  nowSec: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE nodes SET last_config_hash = ?, last_applied_at = ? WHERE id = ?`,
    )
    .bind(hash, nowSec, id)
    .run();
}
