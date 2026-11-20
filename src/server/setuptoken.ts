import 'server-only';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { isRateLimited, rateLimit } from './ratelimit';
import { RECOVERY_SERVER_USER_ID } from './recoveryaccount';
import { globalState } from './state';

// Bootstrapping the first admin without trusting the media server's own idea of "admin".
// While nobody holds the global admin role, a one-time token is printed to the server
// console; signing in with a valid account plus that token claims the role. Only someone who
// can read the console (or the container log) can do that — which is the same person who can
// already restart the app, and the point.
//
// Trade-off: the token lives in memory only. A restart prints a fresh one, which is exactly
// when a lost log line matters; nothing is written to disk.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const LENGTH = 8;
const FAILURES = 8;
// Across all addresses. The per-address limit trusts X-Forwarded-For, which a client can
// write freely when no reverse proxy is in front; this one does not depend on it. 50 wrong
// guesses per window against a 32^8 token is still nothing, and a real admin who is locked
// out for a moment by somebody else's guessing only has to wait the window out.
const GLOBAL_FAILURES = 50;
const GLOBAL_KEY = 'setup-token:*';
const WINDOW_MS = 10 * 60_000;

const state = globalState('setupToken', () => ({ token: null as string | null }));

/** True while no real account holds the global admin role (the /adminlogin emergency one does not count). */
export async function setupTokenPending(): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.globalAdmin, true), ne(users.serverUserId, RECOVERY_SERVER_USER_ID)))
    .limit(1);
  return !row;
}

const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Makes sure a token exists while one is needed, and says so in the log. Called at start-up
 * and again from the login page, so a setup finished after the start still gets one.
 */
export async function announceSetupToken(): Promise<void> {
  if (state.token || !(await setupTokenPending())) return;
  const raw = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  state.token = raw;
  const shown = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  console.log(
    [
      '',
      '[watcharr] ──────────────────────────────────────────────',
      '[watcharr] No admin exists yet. To become the global admin,',
      `[watcharr] sign in and enter this one-time setup token:  ${shown}`,
      '[watcharr] Media server not reachable, so nobody can sign in? Open /adminlogin',
      '[watcharr] and the sign-in link appears here.',
      '[watcharr] ──────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

export type TokenCheck = 'none' | 'valid' | 'invalid' | 'limited';

/**
 * 'none' = nothing to check (no input, or an admin already exists). The token is compared
 * first, so the right one always gets through: the limits only slow down guessing, and with
 * the global one checked before the comparison, anybody could lock the real admin out of
 * setup by sending 50 wrong guesses per window. Only wrong guesses count, so a correct token
 * is never turned away by the poll loop of a Plex login either.
 */
export async function checkSetupToken(input: string | null | undefined, ip: string): Promise<TokenCheck> {
  const given = normalize(input ?? '');
  if (!given || !(await setupTokenPending())) return 'none';
  await announceSetupToken();
  const a = Buffer.from(given);
  const b = Buffer.from(state.token ?? '');
  if (a.length === b.length && b.length > 0 && timingSafeEqual(a, b)) return 'valid';
  const key = `setup-token:${ip}`;
  if (isRateLimited(key, FAILURES) || isRateLimited(GLOBAL_KEY, GLOBAL_FAILURES)) return 'limited';
  rateLimit(key, FAILURES, WINDOW_MS);
  rateLimit(GLOBAL_KEY, GLOBAL_FAILURES, WINDOW_MS);
  return 'invalid';
}

/** Called once the role was actually handed out. */
export function retireSetupToken(): void {
  state.token = null;
}
