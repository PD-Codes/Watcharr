import 'server-only';

// ponytail: in-memory counters, reset on restart. One app container is the documented
// deployment; swap for Redis if the app is ever run with more than one replica.
const hits = new Map<string, { count: number; resetAt: number }>();

// Keys include client-supplied parts (an address from X-Forwarded-For, a user name), so the
// map is bounded: expired counters are swept at most once a minute, and past the cap the
// least recently touched ones go first.
const MAX_KEYS = 10_000;
const SWEEP_EVERY_MS = 60_000;
let nextSweep = 0;

function prune(now: number) {
  if (now < nextSweep && hits.size <= MAX_KEYS) return;
  nextSweep = now + SWEEP_EVERY_MS;
  for (const [key, entry] of hits) if (entry.resetAt < now) hits.delete(key);
  for (const key of hits.keys()) {
    if (hits.size <= MAX_KEYS) break;
    hits.delete(key);
  }
}

/** Counts one hit against `key`; false once more than `limit` hits landed in the window. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  prune(now);
  const entry = hits.get(key);
  if (!entry || entry.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  // Re-inserted so a counter that is still being hit is the last one the cap evicts.
  hits.delete(key);
  hits.set(key, entry);
  return entry.count <= limit;
}

/** Whether `key` is already at its limit, without counting a hit. */
export function isRateLimited(key: string, limit: number): boolean {
  const entry = hits.get(key);
  return Boolean(entry && entry.resetAt >= Date.now() && entry.count >= limit);
}

export function clearRateLimit(key: string): void {
  hits.delete(key);
}

/**
 * The caller's address. X-Forwarded-For is a list the client starts and every proxy appends
 * to, so only the entries added by our own proxies can be trusted: the last one with a single
 * reverse proxy (the default), or further left with WATCHARR_TRUSTED_PROXIES=2 (e.g. Cloudflare
 * in front of nginx). The first entry, used before, was whatever the client claimed — one
 * made-up value per request and no login or PIN limit applied.
 */
export function clientIp(request: Request, hops = trustedHops()): string {
  const chain = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length) return chain[Math.max(0, chain.length - hops)];
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function trustedHops(): number {
  const n = Number(process.env.WATCHARR_TRUSTED_PROXIES ?? 1);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
