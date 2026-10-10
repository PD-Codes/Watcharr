/**
 * Every media server request goes through here, which is why the timeout lives here and
 * not at the call sites. Without it an unreachable server does not fail — the socket just
 * never settles, the catch() around the sync never runs, and because the sync sits in the
 * app layout, every single page hangs forever instead of rendering without live data.
 */
import { isStrainSignal, markStrained } from '../strain';

const DEFAULT_TIMEOUT_MS = 8_000;
/**
 * Whole-library listings and long histories: a big Plex library takes well over 8 s to list
 * while the server is perfectly healthy. Slow there means "large", not "overloaded", so a
 * timeout on such a request fails only that job and does not pause the server.
 */
const BULK_TIMEOUT_MS = 90_000;

export type HttpError = Error & { status?: number };

/** Starts (and logs, once per pause) the backoff for an overloaded host. */
function strained(url: string, reason: string) {
  const pause = markStrained(url, reason);
  if (pause !== null) {
    const host = new URL(url).host;
    const what =
      reason === 'database is locked'
        ? // Said outright: the same words from Watcharr's own SQLite would mean something else entirely.
          `${host} reports "database is locked" — that is the media server's own database (Plex/Jellyfin), not Watcharr's`
        : `${host} looks overloaded (${reason})`;
    console.warn(
      `[watcharr] ${what}; backing off for ${Math.round(pause / 60_000)} min: ` +
        'live polling every 30 s, library, history and artwork jobs paused',
    );
  }
}

/** True when the media server refused the credentials rather than the request. */
export function isUnauthorized(error: unknown): boolean {
  const status = (error as HttpError | null)?.status;
  return status === 401 || status === 403;
}

/** Thin fetch wrapper: JSON in, JSON out, non-2xx throws with the response body. */
export async function apiFetch<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; bulk?: boolean } = {},
): Promise<T> {
  const { bulk = false, timeoutMs = bulk ? BULK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { Accept: 'application/json', ...rest.headers },
      cache: 'no-store',
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Only our own timeout: a refused connection is a server that is down, which the sync's
    // down-backoff already handles, and a caller's abort is not the server's fault.
    if ((error as Error | null)?.name === 'TimeoutError' && !bulk) strained(url, `no answer within ${timeoutMs / 1000} s`);
    throw error;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (isStrainSignal(res.status, body)) {
      strained(url, /database is locked/i.test(body) ? 'database is locked' : `HTTP ${res.status}`);
    }
    const error = new Error(
      `${init.method ?? 'GET'} ${url} failed: ${res.status} ${body.slice(0, 200)}`,
    );
    // The status carried as a field, not only inside the message: a caller that has to
    // react to a dead token (see sync.ts) must not parse English prose to find out.
    (error as HttpError).status = res.status;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
