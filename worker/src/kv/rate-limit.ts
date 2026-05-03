/**
 * Login brute-force throttle — KV counters per IP per minute (brainstorm §5.1).
 * Best-effort only (non-atomic read/modify/write); good enough for v1 abuse friction.
 */

export const LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;
export const LOGIN_RATE_LIMIT_MAX = 10;

function bucketKey(ip: string, windowStartMs: number): string {
  const bucket = Math.floor(windowStartMs / LOGIN_RATE_LIMIT_WINDOW_MS);
  return `rate:auth-login:v1:${ip}:${bucket}`;
}

export type LoginRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

export async function consumeLoginRateLimit(
  kv: KVNamespace,
  ip: string,
  nowMs: number = Date.now(),
): Promise<LoginRateLimitResult> {
  const key = bucketKey(ip, nowMs);
  const raw = await kv.get(key, "text");
  let count = raw ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(count) || count < 0) {
    count = 0;
  }

  if (count >= LOGIN_RATE_LIMIT_MAX) {
    const windowEndMs =
      (Math.floor(nowMs / LOGIN_RATE_LIMIT_WINDOW_MS) + 1) *
      LOGIN_RATE_LIMIT_WINDOW_MS;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowEndMs - nowMs) / 1000),
    );
    return { ok: false, retryAfterSec };
  }

  await kv.put(key, String(count + 1), { expirationTtl: 180 });

  return { ok: true };
}
