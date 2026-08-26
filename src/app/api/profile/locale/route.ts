import { getSession, setUserLocale } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * A user's own language. The target user id comes from the session and never from the
 * body — same rule as the newsletter subscription, and for the same reason: this is a
 * personal setting, so nobody gets to change it on someone else's behalf.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { locale?: string | null } | null;
  // An unknown tag is stored as null, which means "follow the deployment default" — the
  // validation lives in setUserLocale so every caller gets it.
  await setUserLocale(session.user.id, body?.locale ?? null);
  return Response.json({ ok: true });
}
