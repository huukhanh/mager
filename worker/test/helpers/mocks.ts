import type { TunnelKvRecord } from "../../src/types";

export function memoryKv(
  initial?: Record<string, string>,
): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get: async (key: string, _type?: unknown) => {
      void _type;
      const v = store.get(key);
      return v === undefined ? null : v;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

export function noopDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true }),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
}

export function seedTunnelKv(kv: KVNamespace, nodeId: string, rec: TunnelKvRecord) {
  return kv.put(`node:${nodeId}:tunnel`, JSON.stringify(rec));
}
