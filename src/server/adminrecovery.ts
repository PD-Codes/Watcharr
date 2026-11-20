import 'server-only';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { listServers } from './config';
import { isRateLimited, rateLimit } from './ratelimit';
import { RECOVERY_SERVER_USER_ID, RECOVERY_USERNAME } from './recoveryaccount';
import { createSession, type LoginMeta } from './session';
import { globalState } from './state';

// Admin access that does not depend on the media server. Every normal sign-in asks Plex,
// Jellyfin or Emby — so when that server is unreachable (wrong URL, router without NAT
// loopback, server down) nobody gets in, including the one person who could fix the URL.
//
// The way in is the server console, like the setup token: /adminlogin asks for a one-time
// code, the code is printed to the log, and whoever reads the log is the person running the
// container anyway. Nothing is printed until someone asks, so the log does not carry a live
// admin credential the whole time. One code at a time, 15 minutes, used once. Asking again
// while a code is still valid prints that same code: otherwise anybody who can reach
// /adminlogin could keep replacing the code the admin is about to type.
//
// Trade-off: memory only. A restart drops a pending code; requesting a new one is one click.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const LENGTH = 20; // 100 bits: guessing is not the threat model, the rate limit is a courtesy
const TTL_MS = 15 * 60_000;
const FAILURES = 8;
const REQUESTS = 5;
// Across all addresses: the per-address limits trust X-Forwarded-For, which a client can write
// freely when no reverse proxy is in front. Generous enough that an admin is rarely caught by
// somebody else's noise, tight enough that the console cannot be flooded.
const GLOBAL_FAILURES = 50;
const GLOBAL_REQUESTS = 10;
const WINDOW_MS = 10 * 60_000;

/** While everybody together is over the request limit, the pending code is printed at most this often. */
const REPRINT_MS = 60_000;

const state = globalState('adminRecovery', () => ({ token: null as string | null, expires: 0, printedAt: 0 }));

const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const pretty = (raw: string) => raw.match(/.{1,5}/g)!.join('-');

/** The global admin a code signs in: a real account before the emergency one, oldest first. */
async function firstGlobalAdmin() {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.globalAdmin, true))
    .orderBy(sql`${users.serverUserId} = ${RECOVERY_SERVER_USER_ID}`, asc(users.id))
    .limit(1);
  return row ?? null;
}

/** Whether a code would sign in an existing admin (true) or create the emergency one (false). */
export async function hasGlobalAdmin(): Promise<boolean> {
  return !!(await firstGlobalAdmin());
}

/**
 * Prints the code to the console: the pending one while it is still valid (same expiry), a
 * fresh one otherwise. `origin` is APP_URL or empty — never a host taken from the request,
 * which the requester controls; without it only the path and the code are printed.
 * False when this address asked too often.
 */
export async function requestRecoveryCode(origin: string, ip: string): Promise<boolean> {
  if (!rateLimit(`admin-recovery-request:${ip}`, REQUESTS, WINDOW_MS)) return false;
  // Past the global limit the way in stays open: refusing would let anybody who floods
  // /adminlogin from made-up addresses keep the admin out exactly when they need it. Nothing is
  // replaced (the pending code stands, a new one only once none is valid, so still at most one
  // per TTL), and the console gets the code at most once a minute instead of on every request.
  const flooded = !rateLimit('admin-recovery-request:*', GLOBAL_REQUESTS, WINDOW_MS);
  const valid = !!state.token && Date.now() < state.expires;
  if (flooded && valid && Date.now() - state.printedAt < REPRINT_MS) return true;
  if (!valid || !state.token) {
    state.token = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    state.expires = Date.now() + TTL_MS;
  }
  state.printedAt = Date.now();
  const raw: string = state.token;
  const minutes = Math.max(1, Math.ceil((state.expires - Date.now()) / 60_000));
  const admin = await firstGlobalAdmin();
  console.log(
    [
      '',
      '[watcharr] ──────────────────────────────────────────────',
      `[watcharr] Admin sign-in without the media server was requested (from ${ip}).`,
      ...(origin
        ? [
            `[watcharr] Open this link within ${minutes} minute(s); it works once:`,
            `[watcharr]   ${origin}/adminlogin?token=${raw}`,
            `[watcharr] or enter the code on /adminlogin:  ${pretty(raw)}`,
          ]
        : [
            // No host: without APP_URL there is none this app can vouch for.
            `[watcharr] Within ${minutes} minute(s), open this path on the address you use for`,
            '[watcharr] Watcharr (it works once; set APP_URL for a complete link):',
            `[watcharr]   /adminlogin?token=${raw}`,
            `[watcharr] or enter the code on /adminlogin:  ${pretty(raw)}`,
          ]),
      admin
        ? `[watcharr] It signs in as ${admin.username}, the global admin.`
        : '[watcharr] No admin exists yet: it creates a local emergency admin account. The role ' +
          'passes to the server owner as soon as they sign in through the media server.',
      '[watcharr] Did not ask for this? Ignore it; nothing happens without the code.',
      '[watcharr] ──────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
  return true;
}

export type RecoveryResult = 'ok' | 'invalid' | 'limited' | 'no-server';

/**
 * Compares a code with the current one before any limit is consulted, like the setup token:
 * the current code always works, and only wrong guesses are counted and turned away. With the
 * global limit checked first, anybody could keep the admin out by sending wrong codes.
 */
export function checkRecoveryCode(input: string, ip: string): 'valid' | 'invalid' | 'limited' {
  const key = `admin-recovery:${ip}`;
  const globalKey = 'admin-recovery:*';
  const given = Buffer.from(normalize(input));
  const current = Buffer.from(state.token ?? '');
  const valid =
    current.length > 0 &&
    Date.now() < state.expires &&
    given.length === current.length &&
    timingSafeEqual(given, current);
  if (valid) return 'valid';
  if (isRateLimited(key, FAILURES) || isRateLimited(globalKey, GLOBAL_FAILURES)) return 'limited';
  rateLimit(key, FAILURES, WINDOW_MS);
  rateLimit(globalKey, GLOBAL_FAILURES, WINDOW_MS);
  return 'invalid';
}

/** Checks the code and, if it is the current one, signs the browser in as the admin. */
export async function redeemRecoveryCode(input: string, meta: LoginMeta & { ip: string }): Promise<RecoveryResult> {
  const check = checkRecoveryCode(input, meta.ip);
  if (check !== 'valid') return check;

  const admin = await firstGlobalAdmin();
  if (admin) {
    state.token = null; // used once, before anything can fail and invite a retry
    // No media server token: the session can manage the app, but syncs that act as this
    // person on the media server stand down (see sync.ts) instead of dropping the session.
    await createSession(
      admin.serverId,
      {
        serverUserId: admin.serverUserId,
        username: admin.username,
        email: admin.email ?? undefined,
        avatarUrl: admin.avatarUrl ?? undefined,
        isAdmin: admin.isAdmin,
      },
      '',
      meta,
    );
    console.warn(`[watcharr] ${admin.username} signed in through /adminlogin from ${meta.ip}`);
    return 'ok';
  }

  // Nobody to sign in as: the emergency account lives on the first server, because every
  // account belongs to one. The code stays valid until this worked.
  const [server] = await listServers();
  if (!server) return 'no-server';
  state.token = null;
  const row = await createSession(
    server.id,
    { serverUserId: RECOVERY_SERVER_USER_ID, username: RECOVERY_USERNAME, isAdmin: true },
    '',
    meta,
    { claimAdmin: true },
  );
  console.warn(
    `[watcharr] emergency admin account "${row.username}" signed in through /adminlogin from ${meta.ip}` +
      (row.globalAdmin ? '' : ' — it did not get the global admin role, someone claimed it at the same moment'),
  );
  return 'ok';
}
