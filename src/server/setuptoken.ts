import 'server-only';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { isRateLimited, rateLimit } from './ratelimit';
import { globalState } from './state';

// Bootstrapping the first admin without trusting the media server's own idea of "admin".
// While nobody holds the global admin role, a one-time token is printed to the server
// console; signing in with a valid account plus that token claims the role. Only someone who
// can read the console (or the container log) can do that — which is the same person who can
// already restart the app, and the point.
//
// ponytail: the token lives in memory only. A restart prints a fresh one, which is exactly
// when a lost log line matters; nothing is written to disk.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const LENGTH = 8;
const FAILURES = 8;
const WINDOW_MS = 10 * 60_000;

const state = globalState('setupToken', () => ({ token: null as string | null }));

/** True while no account holds the global admin role. */
export async function setupTokenPending(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.globalAdmin, true)).limit(1);
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
      '[watcharr] ──────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

export type TokenCheck = 'none' | 'valid' | 'invalid' | 'limited';

/**
 * 'none' = nothing to check (no input, or an admin already exists). Only wrong guesses count
 * toward the limit, so a correct token is never turned away by the poll loop of a Plex login.
 */
export async function checkSetupToken(input: string | null | undefined, ip: string): Promise<TokenCheck> {
  const given = normalize(input ?? '');
  if (!given || !(await setupTokenPending())) return 'none';
  const key = `setup-token:${ip}`;
  if (isRateLimited(key, FAILURES)) return 'limited';
  await announceSetupToken();
  const a = Buffer.from(given);
  const b = Buffer.from(state.token ?? '');
  if (a.length === b.length && b.length > 0 && timingSafeEqual(a, b)) return 'valid';
  rateLimit(key, FAILURES, WINDOW_MS);
  return 'invalid';
}

/** Called once the role was actually handed out. */
export function retireSetupToken(): void {
  state.token = null;
}
