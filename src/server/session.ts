import 'server-only';
import { randomBytes, createHash } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, count, desc, eq, gt, inArray, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { authSessions, loginHistory, plexTokens, users } from '@/db/schema';
import { isLocale } from '@/i18n';
import { decryptSecret, encryptSecret, hmacSign, hmacVerify, type KeyPurpose } from './crypto';
import type { MediaServerUser } from './adapters';
import { getServer } from './config';
import { lookupCountry } from './geoip';
import { RECOVERY_SERVER_USER_ID } from './recoveryaccount';
import { retireSetupToken } from './setuptoken';
import type { Scope } from './stats';

const COOKIE = 'watcharr_session';
// Admin "view as": a signed pointer from the real session to the user being looked at.
// proxy.ts matches the name too — keep both in step.
export const VIEW_AS_COOKIE = 'watcharr_view_as';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function sign(purpose: KeyPurpose, value: string): string {
  return `${value}.${hmacSign(purpose, value)}`;
}

/** Returns the signed value if the signature is valid (current or pre-split key), otherwise null. */
function unsign(purpose: KeyPurpose, signed: string): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  return hmacVerify(purpose, value, signed.slice(dot + 1)) ? value : null;
}

/*
 * auth_sessions holds sha256(cookie id), never the id itself. The table travels in every
 * backup download and in a copied data volume; with raw ids in it, anyone holding such a copy
 * could still not sign a cookie (that needs SESSION_SECRET), but the ids were the one half
 * of a live sign-in that sat in the database in plain text. The hash is also the handle the
 * UI and the revoke API use, so a raw id never leaves the browser it belongs to.
 *
 * Rows from before carry the raw id: 64 lowercase hex characters, which a base64url hash
 * (43 characters) can never be. They are rewritten the first time they are seen.
 */
export function sessionHandle(rawId: string): string {
  return createHash('sha256').update(rawId).digest('base64url');
}

const isLegacyId = (id: string) => /^[0-9a-f]{64}$/.test(id);

/** Rewrites one pre-hash row to its handle. Losing a race to another request is harmless. */
async function upgradeLegacyRow(rawId: string): Promise<boolean> {
  if (!isLegacyId(rawId)) return false;
  const changed = await db
    .update(authSessions)
    .set({ id: sessionHandle(rawId) })
    .where(eq(authSessions.id, rawId))
    .returning({ id: authSessions.id });
  return changed.length > 0;
}

/**
 * Rewrites every pre-hash row. Run before ids are listed or looked up by handle, so a legacy
 * row is never shown with its raw id and its handle still finds it.
 */
export async function upgradeLegacySessionIds(): Promise<number> {
  const rows = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(sql`length(${authSessions.id}) = 64 AND ${authSessions.id} NOT GLOB '*[^0-9a-f]*'`);
  let upgraded = 0;
  for (const row of rows) if (await upgradeLegacyRow(row.id)) upgraded += 1;
  return upgraded;
}

// The Plex PIN flow: plex.tv hands the token of an approved PIN to anyone who knows its
// (sequential) id and this app's fixed client id. Binding the PIN to the browser that started
// it keeps a stranger from polling neighbouring ids and receiving somebody else's sign-in.
const PIN_COOKIE = 'watcharr_plex_pin';

export async function bindPlexPin(pinId: string): Promise<void> {
  (await cookies()).set(PIN_COOKIE, sign('plex-pin', pinId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: await isSecureRequest(),
    path: '/api/auth/plex',
    maxAge: 20 * 60, // plex.tv lets a PIN expire after about fifteen minutes
  });
}

export async function isPlexPinBound(pinId: string): Promise<boolean> {
  const raw = (await cookies()).get(PIN_COOKIE)?.value;
  return !!raw && unsign('plex-pin', raw) === pinId;
}

// Jellyfin Quick Connect: the pending request (code, secret, device) stays in server memory under
// a random handle (server/quickconnect.ts), and only the browser that started it holds
// the handle, signed. The secret alone redeems the sign-in, so it never reaches a browser, and
// without the binding anybody who learned the six-digit code from a shoulder could poll for it.
const QUICK_CONNECT_COOKIE = 'watcharr_quickconnect';
const QUICK_CONNECT_PATH = '/api/auth/quickconnect';

export async function bindQuickConnect(handle: string, maxAgeSeconds: number): Promise<void> {
  (await cookies()).set(QUICK_CONNECT_COOKIE, sign('quick-connect', handle), {
    httpOnly: true,
    sameSite: 'lax',
    secure: await isSecureRequest(),
    path: QUICK_CONNECT_PATH,
    maxAge: maxAgeSeconds,
  });
}

/** The handle this browser started, if its signature holds. */
export async function boundQuickConnect(): Promise<string | null> {
  const raw = (await cookies()).get(QUICK_CONNECT_COOKIE)?.value;
  return raw ? unsign('quick-connect', raw) : null;
}

export async function clearQuickConnect(): Promise<void> {
  // Same path as when it was set, or the browser keeps it.
  (await cookies()).set(QUICK_CONNECT_COOKIE, '', { httpOnly: true, path: QUICK_CONNECT_PATH, maxAge: 0 });
}

/**
 * Whether the session cookie may carry the Secure flag.
 *
 * Tying this to NODE_ENV is wrong: a browser silently discards a Secure cookie sent over
 * plain HTTP, and a self-hosted deployment on a LAN is plain HTTP far more often than not.
 * The symptom is vicious: the login request answers 200, the redirect fires, the next page
 * finds no session and bounces back to the login screen, with no error logged anywhere. So
 * the flag follows the scheme the request really arrived with. Next sets X-Forwarded-Proto
 * itself ("http" when nothing in front sent one), so a TLS-terminating proxy has to send
 * "https" for the flag to be set. (http://localhost is a secure context either way.)
 *
 * Not named use…(): it is no React hook, and the hook rules treat that prefix as one.
 */
async function isSecureRequest(): Promise<boolean> {
  return (await headers()).get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}

export type SessionUser = typeof users.$inferSelect;

export interface LoginMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * One row per login attempt, successful or not — Tautulli's login/IP history. Best-effort:
 * a logging failure must never be the reason a sign-in fails.
 */
export async function recordLogin(
  serverId: number,
  username: string,
  success: boolean,
  meta: LoginMeta = {},
  userId?: number,
): Promise<void> {
  try {
    const country = meta.ip ? await lookupCountry(meta.ip) : null;
    await db.insert(loginHistory).values({
      serverId,
      userId: userId ?? null,
      username,
      success,
      ip: meta.ip ?? null,
      country,
      userAgent: meta.userAgent ?? null,
    });
  } catch {
    // Best-effort audit trail, never blocks a login.
  }
}

/**
 * A user's active (non-expired) sessions, newest first. Never includes the token itself, and
 * `id` is the handle (sha256 of the cookie id) that revokeSession() takes.
 */
export async function listUserSessions(userId: number) {
  await upgradeLegacySessionIds();
  return db
    .select({ id: authSessions.id, createdAt: authSessions.createdAt, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date())))
    .orderBy(desc(authSessions.createdAt));
}

/** A plex.tv token kept beyond its sign-in (see plex_tokens), with the person it belongs to. */
export interface KeptPlexToken {
  user: SessionUser;
  token: string;
}

/**
 * The kept plex.tv tokens of everybody on the given servers, most recently signed in first, for
 * work done on their behalf while nobody has a page open (sync.ts pulls watchlists with them).
 * One that no longer decrypts (a changed SESSION_SECRET) is skipped and never fails the others.
 */
export async function keptPlexTokens(serverIds: number[]): Promise<KeptPlexToken[]> {
  if (!serverIds.length) return [];
  const rows = await db
    .select({ user: users, token: plexTokens.token })
    .from(plexTokens)
    .innerJoin(users, eq(users.id, plexTokens.userId))
    .where(inArray(users.serverId, serverIds))
    .orderBy(desc(plexTokens.updatedAt), desc(plexTokens.userId));
  const kept: KeptPlexToken[] = [];
  for (const row of rows) {
    let token: string;
    try {
      token = decryptSecret(row.token);
    } catch {
      continue;
    }
    if (token) kept.push({ user: row.user, token });
  }
  return kept;
}

/**
 * Forgets a person's kept plex.tv token after plex.tv refused it, unless a sign-in has replaced
 * it since: the new one has not been refused. Compared as stored, so a sign-in that lands
 * between the check and the delete is not lost either.
 */
export async function dropPlexToken(userId: number, refused: string): Promise<void> {
  const [row] = await db.select({ token: plexTokens.token }).from(plexTokens).where(eq(plexTokens.userId, userId));
  if (!row) return;
  let kept = '';
  try {
    kept = decryptSecret(row.token);
  } catch {
    // Unreadable is as good as refused.
  }
  if (kept && kept !== refused) return;
  await db.delete(plexTokens).where(and(eq(plexTokens.userId, userId), eq(plexTokens.token, row.token)));
}

/**
 * The user's own language. Null means "follow the deployment default", which is also what
 * an unknown tag falls back to — the value reaches the dictionary lookup directly.
 */
export async function setUserLocale(userId: number, locale: string | null): Promise<void> {
  await db
    .update(users)
    .set({ locale: isLocale(locale) ? locale : null })
    .where(eq(users.id, userId));
}

/**
 * Signs one session out remotely — the "someone has my login" button, and sync.ts when the
 * media server rejects the token. Takes the handle (Session.id / listUserSessions().id).
 */
export async function revokeSession(id: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.id, id));
}

/** Signs a person out everywhere, e.g. when their media server role or share changed. */
export async function revokeUserSessions(userId: number): Promise<number> {
  return (await db.delete(authSessions).where(eq(authSessions.userId, userId)).returning({ id: authSessions.id }))
    .length;
}

const loginScope = (serverId?: number) => (serverId ? eq(loginHistory.serverId, serverId) : sql`1 = 1`);

/**
 * Most recent login attempts. Scoped to one server unless the caller is a global admin.
 * `offset` pages further back; the defaults are the first page the security page shows.
 */
export async function listLoginHistory(serverId?: number, limit = 200, offset = 0) {
  return db
    .select()
    .from(loginHistory)
    .where(loginScope(serverId))
    .orderBy(desc(loginHistory.createdAt), desc(loginHistory.id))
    .limit(limit)
    .offset(offset);
}

/** How many login attempts listLoginHistory() can page through, same scope. */
export async function countLoginHistory(serverId?: number): Promise<number> {
  const [row] = await db.select({ n: count() }).from(loginHistory).where(loginScope(serverId));
  return row?.n ?? 0;
}

/** Upserts the media server user locally and issues a signed session cookie. */
export async function createSession(
  serverId: number,
  user: MediaServerUser,
  serverToken: string,
  meta: LoginMeta = {},
  options: { claimAdmin?: boolean } = {},
) {
  // An account created from the user list or a stream (never signed in, so no last-seen)
  // may carry another id for the same person — Plex's local id for its owner. Taking that
  // row over keeps their history in one place instead of leaving a stranded twin.
  const [twin] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.serverId, serverId),
        sql`lower(${users.username}) = ${user.username.trim().toLowerCase()}`,
        sql`${users.lastSeenAt} IS NULL`,
        ne(users.serverUserId, user.serverUserId),
      ),
    )
    .limit(1);
  if (twin) {
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.serverId, serverId), eq(users.serverUserId, user.serverUserId)))
      .limit(1);
    if (!taken) await db.update(users).set({ serverUserId: user.serverUserId }).where(eq(users.id, twin.id));
  }

  const [row] = await db
    .insert(users)
    .values({
      serverId,
      serverUserId: user.serverUserId,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      // The same account id can exist on two servers, so identity is the pair.
      target: [users.serverId, users.serverUserId],
      set: {
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isAdmin: user.isAdmin,
        lastSeenAt: new Date(),
      },
    })
    .returning();

  // Bootstrapping the global admin. The person who ran setup owns the server token, so
  // they are an admin on that server — and only a server admin can claim the role, which
  // is why "whoever signs in first" cannot be hijacked by an ordinary user.
  // A valid setup token (checked by the caller) claims the role even for an account the media
  // server does not call an admin; the claim itself stays the single atomic statement.
  if ((row.isAdmin || options.claimAdmin) && !row.globalAdmin && (await claimGlobalAdmin(row.id))) {
    row.globalAdmin = true;
    if (options.claimAdmin) retireSetupToken();
    // A real admin exists now, so the emergency account steps down. Demoted, not deleted: its
    // login history is the record of who used the back door, and that is worth keeping.
    if (row.serverUserId !== RECOVERY_SERVER_USER_ID) {
      await db
        .update(users)
        .set({ globalAdmin: false, isAdmin: false })
        .where(eq(users.serverUserId, RECOVERY_SERVER_USER_ID));
    }
  }

  // Expired rows are cleaned up here instead of by a cron job.
  await db.delete(authSessions).where(lt(authSessions.expiresAt, new Date()));

  const id = randomBytes(32).toString('hex');
  await db.insert(authSessions).values({
    id: sessionHandle(id),
    userId: row.id,
    serverToken: encryptSecret(serverToken),
    expiresAt: new Date(Date.now() + MAX_AGE_SECONDS * 1000),
  });
  // A Plex sign-in's plex.tv token also outlives this session (see plex_tokens). Other servers'
  // tokens have no use beyond the session and are not kept.
  if (serverToken && (await getServer(serverId))?.serverType === 'plex') {
    const kept = encryptSecret(serverToken);
    await db
      .insert(plexTokens)
      .values({ userId: row.id, token: kept, updatedAt: new Date() })
      .onConflictDoUpdate({ target: plexTokens.userId, set: { token: kept, updatedAt: new Date() } });
  }

  (await cookies()).set(COOKIE, sign('session-cookie', id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: await isSecureRequest(),
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  void recordLogin(serverId, user.username, true, meta, row.id);
  return row;
}

export interface Session {
  /**
   * The session's handle: the auth_sessions row id, sha256 of the cookie's id (never the cookie
   * id itself). Carried so a dead media server token can drop its session (revokeSession).
   */
  id: string;
  user: SessionUser;
  serverToken: string;
  /**
   * Set while an admin looks at the app as another user. `user` is then the person being
   * viewed, `serverToken` is empty (the admin's token must never act on their behalf), and
   * everything that writes must stand down: sync skips, proxy.ts refuses non-GET API calls.
   */
  preview?: { admin: SessionUser };
}

/** The id the session cookie carries, if its signature holds. Never leaves this module. */
async function cookieSessionId(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  return raw ? unsign('session-cookie', raw) : null;
}

async function loadSession(handle: string) {
  const [row] = await db
    .select({ user: users, serverToken: authSessions.serverToken })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, handle), gt(authSessions.expiresAt, new Date())));
  return row;
}

/** Resolves a cookie id to its session: by handle, else a pre-hash row that is upgraded on the spot. */
export async function sessionForCookieId(rawId: string): Promise<Session | null> {
  const handle = sessionHandle(rawId);
  let row = await loadSession(handle);
  // Signed in before ids were hashed: the row still carries the raw id. Upgrading it here
  // instead of signing everybody out is the whole migration. Looked up again whatever the
  // upgrade reports: parallel requests with the same old cookie all miss the first lookup,
  // one of them rewrites the row and the others find nothing left to rewrite, but the row is
  // there under its handle for all of them.
  if (!row && isLegacyId(rawId)) {
    await upgradeLegacyRow(rawId);
    row = await loadSession(handle);
  }
  return row ? { id: handle, user: row.user, serverToken: decryptSecret(row.serverToken) } : null;
}

/** The signed-in person, ignoring any "view as". Use where the real identity matters. */
export async function getRealSession(): Promise<Session | null> {
  const id = await cookieSessionId();
  return id ? sessionForCookieId(id) : null;
}

/** The effective session: the real one, or the viewed user's when an admin is previewing. */
export async function getSession(): Promise<Session | null> {
  const rawId = await cookieSessionId();
  const real = rawId ? await sessionForCookieId(rawId) : null;
  if (!real) return null;
  const raw = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  const payload = raw ? unsign('view-as', raw) : null;
  // Bound to this very sign-in: a cookie copied from another admin's browser means nothing.
  // The binding is the cookie's own id, as before hashing, so proxy.ts can compare the two
  // cookies without a database and previews started before the update keep working.
  const [boundTo, target] = payload?.split(':') ?? [];
  if (boundTo !== rawId || !isAdmin(real.user)) return real;
  const [viewed] = await db.select().from(users).where(eq(users.id, Number(target)));
  if (!viewed || viewed.id === real.user.id || !canSee(real.user, viewed)) return real;
  // Never more rights than the person previewing: a server admin looking at the global admin
  // would otherwise get every global-admin page and the database download for as long as the
  // preview cookie lives (proxy.ts only blocks writes).
  const user = { ...viewed, globalAdmin: viewed.globalAdmin && real.user.globalAdmin };
  return { id: real.id, user, serverToken: '', preview: { admin: real.user } };
}

/**
 * Starts (or, with null, ends) the preview for the signed-in browser. The caller has already
 * checked `canSee`. Binds to the session cookie's own id, which only this module reads.
 */
export async function setViewAs(userId: number | null): Promise<void> {
  const jar = await cookies();
  const rawId = await cookieSessionId();
  if (userId === null || !rawId) {
    jar.delete(VIEW_AS_COOKIE);
    return;
  }
  jar.set(VIEW_AS_COOKIE, sign('view-as', `${rawId}:${userId}`), {
    httpOnly: true,
    sameSite: 'lax',
    secure: await isSecureRequest(),
    path: '/',
    // Session cookie on purpose: closing the browser ends the preview.
  });
}

/**
 * For pages: sends anonymous visitors to the login screen instead of erroring out.
 * The user's own media server comes along, because almost every page needs its slug for
 * artwork or its type for deep links.
 */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect('/login');
  const server = await getServer(session.user.serverId);
  if (!server) redirect('/login');
  return { ...session, server };
}

/** Admin on their own media server, or across the whole deployment. */
export function isAdmin(user: SessionUser): boolean {
  return user.isAdmin || user.globalAdmin;
}

/** For pages: non-admins are sent back to their own dashboard. */
export async function requireAdmin() {
  const session = await requireUser();
  if (!isAdmin(session.user)) redirect('/watchlist');
  return session;
}

/**
 * The same gate for API routes: the session of a global admin, or null. A route answers null with
 * a JSON 403 (apierror.ts::globalAdminRequired); requireGlobalAdmin() below redirects instead,
 * which a fetch() caller would follow into an HTML page it cannot parse.
 */
export async function getGlobalAdminSession(): Promise<Session | null> {
  const session = await getSession();
  return session?.user.globalAdmin ? session : null;
}

/** Server management and cross-server views. A server admin must not get here. */
export async function requireGlobalAdmin() {
  const session = await requireUser();
  if (!session.user.globalAdmin) redirect('/watchlist');
  return session;
}

/**
 * What an admin is allowed to aggregate over: everything for a global admin, and only
 * their own server for a server admin.
 */
export function adminScope(user: SessionUser): Scope {
  return user.globalAdmin ? { userId: null } : { userId: null, serverId: user.serverId };
}

/** Whether an admin may look at another user's data. */
export function canSee(admin: SessionUser, target: { serverId: number }): boolean {
  return admin.globalAdmin || (admin.isAdmin && admin.serverId === target.serverId);
}

/**
 * Makes `userId` the global admin if there is none yet. "Is there one?" and the update are
 * one statement: with a check first and an update after, two admins signing in at the same
 * moment could both find the role free and both take it.
 */
export async function claimGlobalAdmin(userId: number): Promise<boolean> {
  const claimed = await db
    .update(users)
    .set({ globalAdmin: true })
    .where(
      and(
        eq(users.id, userId),
        // The emergency account from /adminlogin does not count: it only exists because nobody
        // could sign in, and the server owner takes the role the moment they can.
        notExists(
          db
            .select({ one: sql`1` })
            .from(users)
            .where(and(eq(users.globalAdmin, true), ne(users.serverUserId, RECOVERY_SERVER_USER_ID))),
        ),
      ),
    )
    .returning({ id: users.id });
  return claimed.length > 0;
}

/**
 * Grants or revokes the global admin role. Revoking refuses to remove the last global admin —
 * the deployment would lose the only account that can manage servers and hand the role back
 * out. "Is there another one?" lives in the UPDATE itself: with a count first and the update
 * after, two admins revoking each other at the same moment could both see two and both win.
 */
export async function setGlobalAdmin(
  userId: number,
  globalAdmin: boolean,
): Promise<'ok' | 'unknown' | 'last-admin'> {
  const changed = await db
    .update(users)
    .set({ globalAdmin })
    .where(
      and(
        eq(users.id, userId),
        globalAdmin
          ? sql`1 = 1`
          : or(
              eq(users.globalAdmin, false),
              // Spelled out: inside UPDATE users, a qualified column could bind to the outer row.
              sql`(SELECT count(*) FROM users WHERE global_admin = 1) > 1`,
            ),
      ),
    )
    .returning({ id: users.id });
  if (changed.length) return 'ok';
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return exists ? 'last-admin' : 'unknown';
}

/** Number of global admins (the emergency account included, as the role check counts it). */
export async function countGlobalAdmins(): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.globalAdmin, true));
  return rows.length;
}

export async function destroySession() {
  const jar = await cookies();
  const id = await cookieSessionId();
  // Both spellings: a session from before hashing may never have been upgraded.
  if (id) await db.delete(authSessions).where(inArray(authSessions.id, [sessionHandle(id), id]));
  jar.delete(COOKIE);
  jar.delete(VIEW_AS_COOKIE);
}
