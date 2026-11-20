/**
 * Finds a way to a Plex server when the configured URL does not answer.
 *
 * The URL people paste is usually the one the Plex web app shows: the public remote-access
 * address (`46-1-2-3.<hash>.plex.direct:<forwarded port>`). From inside the same network that
 * address only works if the router supports NAT loopback, and many do not — the packets just
 * vanish, every request times out, and nobody can sign in. Plex clients never hit this,
 * because they ask plex.tv for all of a server's connections (LAN, public, relay) and use
 * the first that answers. This does the same, so the app keeps working without anyone
 * having to know what hairpin NAT is.
 *
 * The route found is process memory only: a restart pays one timeout and finds it again.
 * No 'server-only' import: pure apart from fetch and the clock, so the tests import it.
 */
import { isIP } from 'node:net';
import { globalState } from '../state';
import { clearStrained } from '../strain';

interface PlexConnection {
  uri?: string;
  address?: string;
  port?: number;
  protocol?: string;
  local?: boolean;
  relay?: boolean;
  IPv6?: boolean;
}

interface PlexResource {
  clientIdentifier?: string;
  provides?: string;
  owned?: boolean;
  connections?: PlexConnection[];
}

interface Route {
  url: string;
  at: number;
}

const PLEX_TV_RESOURCES = 'https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1';
const PROBE_TIMEOUT_MS = 4_000;
const RESOURCES_TIMEOUT_MS = 25_000;
/** A detour is re-checked after this long, so a fixed router or URL is picked up again. */
export const ROUTE_RECHECK_MS = 30 * 60_000;
/** Nothing reachable: plex.tv is not asked again before this, or every failed request would. */
const MISS_BACKOFF_MS = 60_000;

const state = () =>
  globalState('plexRoutes', () => ({
    routes: new Map<string, Route>(),
    misses: new Map<string, number>(),
    inflight: new Map<string, Promise<string | null>>(),
  }));

const norm = (url: string) => url.replace(/\/+$/, '');

/** The URL requests to this server go to right now: a found detour, else the configured one. */
export function plexRoute(configuredUrl: string): string {
  return state().routes.get(norm(configuredUrl))?.url ?? norm(configuredUrl);
}

/** Whether a detour is old enough to look again for the configured URL. */
export function routeIsStale(configuredUrl: string, now = Date.now()): boolean {
  const route = state().routes.get(norm(configuredUrl));
  return !!route && now - route.at > ROUTE_RECHECK_MS;
}

/** A request that never reached the server, as opposed to one the server answered badly. */
export function isUnreachable(error: unknown): boolean {
  const e = error as { name?: string; status?: number; message?: string } | null;
  if (!e || e.status !== undefined) return false;
  // undici reports refused, reset and DNS failures as `TypeError: fetch failed`.
  return e.name === 'TimeoutError' || (e.name === 'TypeError' && /fetch failed/i.test(e.message ?? ''));
}

const PLEX_DIRECT = /\.([0-9a-f]{32})\.plex\.direct$/i;

/**
 * The detour in use when it is plain http to a bare IP address, else null: what a router
 * without NAT loopback and with DNS rebind protection leaves as the only way in. The admin
 * token then crosses the network unencrypted, which the system check reports. A configured URL
 * that is itself plain http is the admin's own choice and not reported here.
 */
export function plainLanRoute(configuredUrl: string): string | null {
  const url = plexRoute(configuredUrl);
  if (url === norm(configuredUrl)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && isIP(parsed.hostname.replace(/^\[|\]$/g, '')) !== 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Which of the account's servers the configured URL means, and every URL worth trying for
 * it, best first. Pure, so the ordering is testable.
 */
export function routeCandidates(
  resources: unknown,
  configuredUrl: string,
): { machineId: string; urls: string[] } | null {
  if (!Array.isArray(resources)) return null;
  const servers = (resources as PlexResource[]).filter(
    (r) => r.clientIdentifier && (r.provides ?? 'server').split(',').includes('server'),
  );
  let configured: URL;
  try {
    configured = new URL(configuredUrl);
  } catch {
    return null;
  }
  const host = configured.hostname.toLowerCase();
  const port = Number(configured.port || (configured.protocol === 'https:' ? 443 : 80));
  const hash = PLEX_DIRECT.exec(host)?.[1]?.toLowerCase();

  const matches = (r: PlexResource) =>
    (r.connections ?? []).some((c) => {
      try {
        const u = new URL(c.uri ?? '');
        if (u.origin === configured.origin) return true;
        // Every plex.direct name of one server carries that server's certificate hash.
        if (hash && PLEX_DIRECT.exec(u.hostname)?.[1]?.toLowerCase() === hash) return true;
      } catch {
        // A connection without a usable uri can still match by address below.
      }
      return c.address?.toLowerCase() === host && c.port === port;
    });

  // The admin token belongs to the server's owner; with one owned server there is nothing
  // to confuse, and /identity still has to confirm it before a single request goes there.
  const owned = servers.filter((r) => r.owned);
  const server = servers.find(matches) ?? (owned.length === 1 ? owned[0] : undefined);
  if (!server?.clientIdentifier) return null;

  // Configured URL first, then the LAN (its plex.direct name, then the bare address), public,
  // relay last. Every candidate is confirmed through /identity (machine id, no token) before a
  // request with the admin token goes there.
  //
  // Plain http to a bare LAN address is kept on purpose, whatever the configured URL looks like:
  // the case this module exists for is an https plex.direct URL without NAT loopback, and many
  // routers (Fritz!Box among them) refuse DNS answers that point at a private address, so the
  // LAN plex.direct name does not resolve either. Without the bare address that setup has no
  // way in at all. The price, the admin token crossing the LAN unencrypted, is made visible in
  // the system check (plainLanRoute below) instead of locking the deployment out.
  const rank = (c: PlexConnection) => (c.relay ? 4 : c.IPv6 ? 3 : c.local ? 0 : 2);
  const urls: string[] = [norm(configuredUrl)];
  for (const c of [...(server.connections ?? [])].sort((a, b) => rank(a) - rank(b))) {
    if (c.uri) urls.push(norm(c.uri));
    if (c.local && !c.relay && c.address && c.port) {
      const address = c.IPv6 ? `[${c.address}]` : c.address;
      urls.push(`http://${address}:${c.port}`);
    }
  }
  return { machineId: server.clientIdentifier, urls: [...new Set(urls)] };
}

/** Asks an address which server it is. `headers` must not carry a token (see discover). */
async function probe(url: string, machineId: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${url}/identity`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { MediaContainer?: { machineIdentifier?: string } };
    // The same LAN address can be a different Plex server after a move; only this one counts.
    return body.MediaContainer?.machineIdentifier === machineId;
  } catch {
    return false;
  }
}

async function discover(configuredUrl: string, headers: Record<string, string>): Promise<string | null> {
  const key = norm(configuredUrl);
  const { routes, misses } = state();
  const resources = await fetch(PLEX_TV_RESOURCES, {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(RESOURCES_TIMEOUT_MS),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  const plan = routeCandidates(resources, configuredUrl);
  // Never with the token: the LAN addresses plex.tv lists are the server's LAN, and from
  // where Watcharr runs the same private address can be any other device. /identity answers
  // without authentication, so nothing is lost by leaving it out.
  const anonymous = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-plex-token'));
  // All at once: the slowest dead address costs the probe timeout once, not once per address.
  const answers = plan ? await Promise.all(plan.urls.map((u) => probe(u, plan.machineId, anonymous))) : [];
  const found = plan?.urls[answers.indexOf(true)] ?? null;

  const before = plexRoute(configuredUrl);
  if (!found) {
    // Said once per outage, not on every retry.
    const first = !misses.has(key);
    misses.set(key, Date.now());
    if (first) {
      console.warn(
        `[watcharr] ${new URL(configuredUrl).host} does not answer, and plex.tv lists no other ` +
          'connection to this server that does; retrying every minute',
      );
    }
    return null;
  }
  misses.delete(key);
  if (found === key) routes.delete(key);
  else routes.set(key, { url: found, at: Date.now() });
  if (found !== before) {
    // The timeout that got us here paused the dead address as "overloaded"; the server is fine.
    clearStrained(configuredUrl);
    clearStrained(before);
    console.warn(
      found === key
        ? `[watcharr] ${new URL(configuredUrl).host} answers again; using it directly`
        : `[watcharr] ${new URL(configuredUrl).host} does not answer from here; connected through ${new URL(found).host} instead (found via plex.tv)`,
    );
  }
  return found;
}

/**
 * Looks for a working URL. One search per server at a time; callers arriving meanwhile get
 * the same answer. After a miss plex.tv is left alone for a minute.
 */
export function findPlexRoute(configuredUrl: string, headers: Record<string, string>): Promise<string | null> {
  const key = norm(configuredUrl);
  const { inflight, misses } = state();
  const running = inflight.get(key);
  if (running) return running;
  if (Date.now() - (misses.get(key) ?? 0) < MISS_BACKOFF_MS) return Promise.resolve(null);
  const job = discover(configuredUrl, headers).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Tests only. */
export function resetPlexRoutes(): void {
  const s = state();
  s.routes.clear();
  s.misses.clear();
  s.inflight.clear();
}
