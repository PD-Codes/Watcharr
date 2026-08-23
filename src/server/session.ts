import 'server-only';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '@/db';
import { authSessions, users } from '@/db/schema';
import { decryptSecret, encryptSecret } from './crypto';
import type { MediaServerUser } from './adapters';

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

/**
 * Whether the session cookie may carry the Secure flag.
 *
 * Tying this to NODE_ENV is the obvious thing and it is wrong: a browser silently discards
 * a Secure cookie sent over plain HTTP, and a self-hosted deployment on a LAN is plain HTTP
 * far more often than not. The symptom is vicious — the login request answers 200, the
 * redirect fires, the next page finds no session and bounces straight back to the login
 * screen, with no error logged anywhere. So the flag follows the actual scheme instead:
 * what the reverse proxy reports, or, with no proxy in front, what APP_URL says.
 *
 * http://localhost is treated as a secure context by browsers, so it works either way.
 */
async function useSecureCookie(): Promise<boolean> {
  const forwarded = (await headers()).get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwarded) return forwarded === 'https';
  return (process.env.APP_URL ?? '').startsWith('https://');
}

export type SessionUser = typeof users.$inferSelect;

/** Upserts the media server user locally and issues a signed session cookie. */
export async function createSession(user: MediaServerUser, serverToken: string) {
  const [row] = await db
    .insert(users)
    .values({
      serverUserId: user.serverUserId,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.serverUserId,
      set: {
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isAdmin: user.isAdmin,
        lastSeenAt: new Date(),
      },
    })
    .returning();

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
    secure: await useSecureCookie(),
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return row;
}

export async function getSession(): Promise<{ user: SessionUser; serverToken: string } | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const id = unsign(raw);
  if (!id) return null;

  const [row] = await db
    .select({ user: users, serverToken: authSessions.serverToken })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, id), gt(authSessions.expiresAt, new Date())));
  return row ? { user: row.user, serverToken: decryptSecret(row.serverToken) } : null;
}

/** For pages: sends anonymous visitors to the login screen instead of erroring out. */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** For pages: non-admins are sent back to their own dashboard. */
export async function requireAdmin() {
  const session = await requireUser();
  if (!session.user.isAdmin) redirect('/watchlist');
  return session;
}

export async function destroySession() {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  const id = raw ? unsign(raw) : null;
  if (id) await db.delete(authSessions).where(eq(authSessions.id, id));
  jar.delete(COOKIE);
}
