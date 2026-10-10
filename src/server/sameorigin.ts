// Pure on purpose (no server-only import): the unit test runs it without Next.
// Applied to every /api request by src/proxy.ts.

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const firstValue = (value: string | null | undefined) => value?.split(',')[0]?.trim().toLowerCase();

/**
 * True when a state-changing request was started by a page on another site.
 *
 * Session cookies are SameSite=lax, which still lets a same-site sibling (another
 * subdomain) through, and a login POST has no cookie to protect at all. Browsers say where
 * a request came from, so this reads that instead of adding a token to every form.
 *
 * A request carrying neither header does not come from a browser page — a script or curl —
 * and the cross-site attack this guards against needs a browser, which always sends one.
 */
export function isCrossSiteWrite(
  method: string,
  headers: { get(name: string): string | null },
  appUrl: string | undefined = process.env.APP_URL,
): boolean {
  if (!WRITES.has(method.toUpperCase())) return false;

  // Wins over Origin: it does not depend on what Host a reverse proxy passes on.
  const site = headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';

  const origin = headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true; // "null", from a sandboxed frame or a privacy redirect
  }

  return !acceptedHosts(headers, appUrl).includes(originHost);
}

/** The hosts this app answers as: what the proxy forwarded, the Host header, APP_URL. */
export function acceptedHosts(
  headers: { get(name: string): string | null },
  appUrl: string | undefined = process.env.APP_URL,
): (string | undefined)[] {
  const accepted = [firstValue(headers.get('x-forwarded-host')), firstValue(headers.get('host'))];
  try {
    if (appUrl) accepted.push(new URL(appUrl).host.toLowerCase());
  } catch {
    // An unusable APP_URL just means it cannot vouch for anything.
  }
  return accepted;
}
