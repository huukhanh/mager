import type { Context } from "hono";
import { insertAudit } from "../db/audit";
import { getNode, updateNodeName } from "../db/nodes";
import type { HonoEnv } from "../types";

export async function patchNodeHandler(c: Context<HonoEnv>): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "missing_node_id" }, 400);
  }

  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ error: "name_required" }, 400);
  }

  const existing = await getNode(c.env.DB, id);
  if (!existing) {
    return c.json({ error: "not_found" }, 404);
  }

  await updateNodeName(c.env.DB, id, name);

  const nowSec = Math.floor(Date.now() / 1000);
  await insertAudit(c.env.DB, {
    nodeId: id,
    action: "rename_node",
    detail: JSON.stringify({ from: existing.name, to: name }),
    actor: "admin",
    createdAt: nowSec,
  });

  return c.json({ ok: true });
}
