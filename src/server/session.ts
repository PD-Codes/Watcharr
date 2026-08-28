import 'server-only';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import { authSessions, loginHistory, users } from '@/db/schema';
import { isLocale } from '@/i18n';
import { decryptSecret, encryptSecret } from './crypto';
import type { MediaServerUser } from './adapters';
import { getServer } from './config';
import { lookupCountry } from './geoip';
import type { Scope } from './stats';

const COOKIE = 'watcharr_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

function sign(id: string): string {
  return `${id}.${createHmac('sha256', secret()).update(id).digest('hex')}`;
}

/** Returns the session id if the signature is valid, otherwise null. */
function unsign(value: string): string | null {
  const [id, mac] = value.split('.');
  if (!id || !mac) return null;
  const expected = createHmac('sha256', secret()).update(id).digest('hex');
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
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

/** A user's active (non-expired) sessions, newest first. Never includes the token itself. */
export async function listUserSessions(userId: number) {
  return db
    .select({ id: authSessions.id, createdAt: authSessions.createdAt, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date())))
    .orderBy(desc(authSessions.createdAt));
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

/** Signs one session out remotely — the "someone has my login" button. */
export async function revokeSession(id: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.id, id));
}

/** Most recent login attempts. Scoped to one server unless the caller is a global admin. */
export async function listLoginHistory(serverId?: number, limit = 200) {
  return db
    .select()
    .from(loginHistory)
    .where(serverId ? eq(loginHistory.serverId, serverId) : sql`1 = 1`)
    .orderBy(desc(loginHistory.createdAt))
    .limit(limit);
}

/** Upserts the media server user locally and issues a signed session cookie. */
export async function createSession(
  serverId: number,
  user: MediaServerUser,
  serverToken: string,
  meta: LoginMeta = {},
) {
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
  if (row.isAdmin && !row.globalAdmin && (await countGlobalAdmins()) === 0) {
    await db.update(users).set({ globalAdmin: true }).where(eq(users.id, row.id));
    row.globalAdmin = true;
  }

  // Expired rows are cleaned up here instead of by a cron job.
  await db.delete(authSessions).where(lt(authSessions.expiresAt, new Date()));

  const id = randomBytes(32).toString('hex');
  await db.insert(authSessions).values({
    id,
    userId: row.id,
    serverToken: encryptSecret(serverToken),
    expiresAt: new Date(Date.now() + MAX_AGE_SECONDS * 1000),
  });

  (await cookies()).set(COOKIE, sign(id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  void recordLogin(serverId, user.username, true, meta, row.id);
  return row;
}

export interface Session {
  /** The auth_sessions row id. Carried so a dead media server token can drop its session. */
  id: string;
  user: SessionUser;
  serverToken: string;
}

export async function getSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const id = unsign(raw);
  if (!id) return null;

  const [row] = await db
    .select({ user: users, serverToken: authSessions.serverToken })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, id), gt(authSessions.expiresAt, new Date())));
  return row ? { id, user: row.user, serverToken: decryptSecret(row.serverToken) } : null;
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
 * Refuses to remove the last global admin — the deployment would lose the only account
 * that can manage servers and hand the role back out.
 */
export async function countGlobalAdmins(): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.globalAdmin, true));
  return rows.length;
}

export async function destroySession() {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  const id = raw ? unsign(raw) : null;
  if (id) await db.delete(authSessions).where(eq(authSessions.id, id));
  jar.delete(COOKIE);
}
