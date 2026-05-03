import type { Context } from "hono";
import type { IngressRuleEntry, PutIngressRequestBody } from "../../../schema/api";
import { insertAudit } from "../db/audit";
import { getNode } from "../db/nodes";
import { replaceIngressForNode } from "../db/ingress";
import { putIngressBlob } from "../kv/ingress";
import type { HonoEnv } from "../types";
import { validateIngressRules } from "../util/validation";

export async function putIngressHandler(c: Context<HonoEnv>): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "missing_node_id" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const raw =
    body && typeof body === "object" && "ingress" in body
      ? (body as PutIngressRequestBody).ingress
      : undefined;

  if (!validateIngressRules(raw)) {
    return c.json({ error: "invalid_ingress" }, 422);
  }

  const normalized: IngressRuleEntry[] = raw.map((r) => ({
    hostname: r.hostname.trim(),
    service: r.service.trim(),
  }));

  const existing = await getNode(c.env.DB, id);
  if (!existing) {
    return c.json({ error: "not_found" }, 404);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await replaceIngressForNode(c.env.DB, id, normalized, nowSec);
  await putIngressBlob(c.env.KV, id, normalized);

  await insertAudit(c.env.DB, {
    nodeId: id,
    action: "set_ingress",
    detail: JSON.stringify({ count: normalized.length }),
    actor: "admin",
    createdAt: nowSec,
  });

  return c.json({ ok: true });
}
