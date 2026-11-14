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
// admin credential the whole time. One code at a time, 15 minutes, used once.
//
// ponytail: memory only. A restart drops a pending code; requesting a new one is one click.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const LENGTH = 20; // 100 bits: guessing is not the threat model, the rate limit is a courtesy
const TTL_MS = 15 * 60_000;
const FAILURES = 8;
const REQUESTS = 5;
const WINDOW_MS = 10 * 60_000;

const state = globalState('adminRecovery', () => ({ token: null as string | null, expires: 0 }));

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

/** Prints a fresh code and link to the console. False when this address asked too often. */
export async function requestRecoveryCode(origin: string, ip: string): Promise<boolean> {
  if (!rateLimit(`admin-recovery-request:${ip}`, REQUESTS, WINDOW_MS)) return false;
  const raw = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  state.token = raw;
  state.expires = Date.now() + TTL_MS;
  const admin = await firstGlobalAdmin();
  console.log(
    [
      '',
      '[watcharr] ──────────────────────────────────────────────',
      `[watcharr] Admin sign-in without the media server was requested (from ${ip}).`,
      '[watcharr] Open this link within 15 minutes; it works once:',
      `[watcharr]   ${origin}/adminlogin?token=${raw}`,
      `[watcharr] or enter the code on /adminlogin:  ${pretty(raw)}`,
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

/** Checks the code and, if it is the current one, signs the browser in as the admin. */
export async function redeemRecoveryCode(input: string, meta: LoginMeta & { ip: string }): Promise<RecoveryResult> {
  const key = `admin-recovery:${meta.ip}`;
  if (isRateLimited(key, FAILURES)) return 'limited';
  const given = Buffer.from(normalize(input));
  const current = Buffer.from(state.token ?? '');
  const valid =
    current.length > 0 &&
    Date.now() < state.expires &&
    given.length === current.length &&
    timingSafeEqual(given, current);
  if (!valid) {
    rateLimit(key, FAILURES, WINDOW_MS);
    return 'invalid';
  }

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
