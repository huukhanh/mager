import type { IngressRuleEntry } from "../../../schema/api";

export function ingressKvKey(nodeId: string): string {
  return `node:${nodeId}:ingress`;
}

export async function getIngressBlob(
  kv: KVNamespace,
  nodeId: string,
): Promise<IngressRuleEntry[] | null> {
  const raw = await kv.get(ingressKvKey(nodeId), "text");
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    return v as IngressRuleEntry[];
  } catch {
    return null;
  }
}

export async function putIngressBlob(
  kv: KVNamespace,
  nodeId: string,
  rules: IngressRuleEntry[],
): Promise<void> {
  await kv.put(ingressKvKey(nodeId), JSON.stringify(rules));
}
