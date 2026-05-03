import type { TunnelKvRecord } from "../types";

export function tunnelKvKey(nodeId: string): string {
  return `node:${nodeId}:tunnel`;
}

export async function getTunnelRecord(
  kv: KVNamespace,
  nodeId: string,
): Promise<TunnelKvRecord | null> {
  const raw = await kv.get(tunnelKvKey(nodeId), "text");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TunnelKvRecord;
  } catch {
    return null;
  }
}

export async function putTunnelRecord(
  kv: KVNamespace,
  nodeId: string,
  rec: TunnelKvRecord,
): Promise<void> {
  await kv.put(tunnelKvKey(nodeId), JSON.stringify(rec));
}

export async function deleteTunnelRecord(
  kv: KVNamespace,
  nodeId: string,
): Promise<void> {
  await kv.delete(tunnelKvKey(nodeId));
}
