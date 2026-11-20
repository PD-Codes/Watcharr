import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { getSession } from '@/server/session';
import { apiError, unauthorized } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/**
 * A user's own colour scheme. Like the locale, the target comes from the session and never
 * from the body, and it lives in the database so the same account looks the same on every
 * device. 'system' clears the choice. A "view as" preview never gets here: proxy.ts refuses
 * every write while one is active, so an admin cannot restyle someone else's account.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = (await request.json().catch(() => null)) as { theme?: unknown } | null;
  const theme = body?.theme;
  if (theme !== 'dark' && theme !== 'light' && theme !== 'system') {
    return apiError(400, 'invalid-theme', 'err.invalidTheme');
  }

  await db
    .update(users)
    .set({ theme: theme === 'system' ? null : theme })
    .where(eq(users.id, session.user.id));
  return Response.json({ ok: true });
}
