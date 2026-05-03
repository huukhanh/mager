import { describe, it, expect } from "vitest";
import {
  consumeLoginRateLimit,
  LOGIN_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_WINDOW_MS,
} from "../../src/kv/rate-limit";
import { memoryKv } from "../helpers/mocks";

describe("consumeLoginRateLimit", () => {
  it("allows up to LOGIN_RATE_LIMIT_MAX attempts then blocks within the window", async () => {
    const kv = memoryKv();
    const ip = "203.0.113.50";
    const now = 1_700_000_000_000;

    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      const r = await consumeLoginRateLimit(kv, ip, now);
      expect(r.ok).toBe(true);
    }

    const blocked = await consumeLoginRateLimit(kv, ip, now);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it("uses a fresh bucket after the window rolls", async () => {
    const kv = memoryKv();
    const ip = "198.51.100.10";
    const t0 = 1_700_000_000_000;

    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      await consumeLoginRateLimit(kv, ip, t0);
    }
    expect((await consumeLoginRateLimit(kv, ip, t0)).ok).toBe(false);

    const t1 = t0 + LOGIN_RATE_LIMIT_WINDOW_MS;
    expect((await consumeLoginRateLimit(kv, ip, t1)).ok).toBe(true);
  });
});
