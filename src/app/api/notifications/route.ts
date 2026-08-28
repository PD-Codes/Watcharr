import { NextResponse } from 'next/server';
import { selectableEvents, setUserPrefs } from '@/server/notifications';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

// Keyed off the session, never off a user id in the body: these are the caller's own
// notifications, the same rule the newsletter route follows.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  const body = (await request.json()) as { email?: string | null; events?: string[] };
  const address = body.email?.trim() || null;
  if (address && !EMAIL.test(address)) {
    return NextResponse.json({ error: 'That does not look like an email address' }, { status: 400 });
  }

  // The allowlist is applied here as well as in the form: a non-admin must not be able to
  // subscribe to server-wide events by posting their keys directly.
  const allowed = selectableEvents(session.user.isAdmin || session.user.globalAdmin) as string[];
  const events = (body.events ?? []).filter((event) => allowed.includes(event));
  if (events.length && !address) {
    return NextResponse.json({ error: 'An email address is required' }, { status: 400 });
  }

  await setUserPrefs(session.user.id, { email: address, events });
  return NextResponse.json({ ok: true });
}
