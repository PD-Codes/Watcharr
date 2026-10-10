// Backpressure per upstream host. No 'server-only': pure apart from the clock, so the test
// script imports it directly, and adapters/http.ts (which is shared with tests) can feed it.
//
// A media server under load says so in a few ways: Plex answers 500 with "database is locked"
// from its own SQLite while a scan runs, a proxy in front answers 502/503/504, TMDB answers 429,
// or nothing answers within the timeout. Each of those used to be retried on the next tick as
// if nothing had happened — every five seconds, plus the library, history and artwork jobs —
// which is exactly the load that keeps a struggling Plex struggling. A strained host gets a
// pause instead: the sync polls it rarely and skips everything that can wait.

/** First pause, and the longest one a repeat can grow to. */
export const STRAIN_BASE_MS = 3 * 60_000;
export const STRAIN_MAX_MS = 15 * 60_000;
/** A new strain this soon after the last one ended counts as a repeat and doubles the pause. */
const REPEAT_WINDOW_MS = 30 * 60_000;

interface Strain {
  until: number;
  level: number;
  reason: string;
}

const root = globalThis as unknown as { __watcharrStrain?: Map<string, Strain> };
const strains = () => (root.__watcharrStrain ??= new Map());

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

/** What counts as "the server is overloaded" rather than "the request was wrong". */
export function isStrainSignal(status: number | null, body = ''): boolean {
  if (status === null) return true; // timeout or connection dropped mid-way
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (status >= 500 && /database is locked|sqlite_busy|busy db/i.test(body)) return true;
  // Any other 500 is a fault, not load; it is reported as before and not paused for.
  return false;
}

/**
 * Records that `url`'s host is overloaded. Returns the pause in ms when this starts a new pause
 * (so the caller can log once), or null while one is already running.
 */
export function markStrained(url: string, reason: string, now = Date.now()): number | null {
  const host = hostOf(url);
  const current = strains().get(host);
  if (current && current.until > now) return null;
  const repeat = current && now - current.until < REPEAT_WINDOW_MS;
  const level = repeat ? current.level + 1 : 0;
  const pause = Math.min(STRAIN_BASE_MS * 2 ** level, STRAIN_MAX_MS);
  strains().set(host, { until: now + pause, level, reason });
  return pause;
}

/** Whether `url`'s host is in a pause right now. */
export function isStrained(url: string, now = Date.now()): boolean {
  return (strains().get(hostOf(url))?.until ?? 0) > now;
}

/** Hosts currently paused, for the system check. */
export function strainedHosts(now = Date.now()): { host: string; until: number; reason: string }[] {
  return [...strains()]
    .filter(([, s]) => s.until > now)
    .map(([host, s]) => ({ host, until: s.until, reason: s.reason }));
}

/** Tests only. */
export function resetStrain(): void {
  strains().clear();
}
