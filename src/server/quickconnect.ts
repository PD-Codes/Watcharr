import 'server-only';
import { randomBytes } from 'node:crypto';
import { supportsQuickConnect, type QuickConnectRequest } from '@/server/adapters';
import { getAdapter, getServer } from '@/server/config';
import { isRateLimited, rateLimit } from '@/server/ratelimit';
import { globalState } from '@/server/state';

// Pending Quick Connect sign-ins. Not a route: a route.ts may export only what Next allows, so
// what the start, check and cancel routes share lives here (see "Fallen" in CLAUDE.md).

/** Jellyfin forgets an unanswered request after about ten minutes; so does this list. */
export const QUICK_CONNECT_TTL_MS = 10 * 60_000;
// The start route is open to anyone, so the list is bounded: past the cap the oldest go first.
const MAX_PENDING = 500;

export interface PendingQuickConnect {
  serverId: number;
  request: QuickConnectRequest;
  expiresAt: number;
}

// Process-wide (state.ts): the routes and anything else that looks must share one list.
const pending = globalState('quickconnect.pending', () => new Map<string, PendingQuickConnect>());

function prune(now: number) {
  for (const [handle, entry] of pending) if (entry.expiresAt <= now) pending.delete(handle);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
}

/** Stores a request and returns the random handle the browser gets (signed) instead of it. */
export function putPending(serverId: number, request: QuickConnectRequest, now = Date.now()): PendingQuickConnect & { handle: string } {
  prune(now);
  const handle = randomBytes(24).toString('base64url');
  const entry = { serverId, request, expiresAt: now + QUICK_CONNECT_TTL_MS };
  pending.set(handle, entry);
  return { handle, ...entry };
}

export function getPending(handle: string, now = Date.now()): PendingQuickConnect | null {
  const entry = pending.get(handle);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    pending.delete(handle);
    return null;
  }
  return entry;
}

/**
 * Removes and returns the request. Synchronous on purpose: two polls that both saw "authorized"
 * must not both redeem it, and only one of them gets the entry.
 */
export function takePending(handle: string): PendingQuickConnect | null {
  const entry = getPending(handle);
  if (entry) pending.delete(handle);
  return entry;
}

export function dropPending(handle: string): void {
  pending.delete(handle);
}

// The login page asks on every render whether to offer the button; one request a minute per
// server is plenty, and an unreachable server must not hold the page for a timeout each time.
const availability = globalState('quickconnect.available', () => new Map<number, { at: number; value: boolean }>());
const AVAILABILITY_TTL_MS = 60_000;

/** Whether the login page should offer Quick Connect: Jellyfin with the feature switched on. */
export async function quickConnectAvailable(serverId: number): Promise<boolean> {
  const hit = availability.get(serverId);
  if (hit && Date.now() - hit.at < AVAILABILITY_TTL_MS) return hit.value;
  const server = await getServer(serverId);
  let value = false;
  if (server?.serverType === 'jellyfin') {
    const adapter = await getAdapter(serverId);
    value = supportsQuickConnect(adapter) && (await adapter.quickConnectEnabled().catch(() => false));
  }
  availability.set(serverId, { at: Date.now(), value });
  return value;
}

/**
 * The Quick Connect page of the Jellyfin web client, without the code. Pre-filling it (jellyfin-web
 * reads `?code=`) made a ready-made phishing link: anyone could start a sign-in here and send
 * the victim a link that approves *their* code in one click, signing the attacker in as the
 * victim. The person has to type the code they see on this page themselves. Offered only for an
 * https address: the start route answers anonymous callers, and a plain-http URL is usually the
 * internal one (a container name, a LAN address) that should not be handed to whoever asks —
 * nor would it open from outside.
 */
export function jellyfinQuickConnectUrl(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:') return null;
    return `${serverUrl.replace(/\/+$/, '')}/web/index.html#/quickconnect`;
  } catch {
    return null;
  }
}

/** Starts per address and minute, and for everybody together per server and minute. */
const STARTS_PER_IP = 10;
// The per-address limit trusts X-Forwarded-For, which a client without a proxy in front writes
// itself. Every start costs the media server a request and takes a slot in the pending list, so
// all of them together stay well below what the list holds over a code's lifetime
// (MAX_PENDING / 10 min): otherwise a flood would push out the codes real people are typing.
const STARTS_GLOBAL = 30;
const START_WINDOW_MS = 60_000;

/** Counts one start; false when this address or everybody together started too many. */
export function allowQuickConnectStart(serverId: number, ip: string): boolean {
  const all = `quickconnect-start:${serverId}:*`;
  if (isRateLimited(all, STARTS_GLOBAL)) return false;
  if (!rateLimit(`quickconnect-start:${serverId}:${ip}`, STARTS_PER_IP, START_WINDOW_MS)) return false;
  return rateLimit(all, STARTS_GLOBAL, START_WINDOW_MS);
}
