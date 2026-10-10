import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { getT } from '@/i18n/server';
import { isOwnAddress, sendConfirmation } from '@/server/mailconfirm';
import { selectableEvents, setUserPrefs } from '@/server/notifications';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

// Keyed off the session, never off a user id in the body: these are the caller's own
// notifications, the same rule the newsletter route follows.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  const body = await readBody(request, { email: 'string', events: 'strings' });
  if (!body) return badBody();
  const address = body.email?.trim() || null;
  if (address && !EMAIL.test(address)) {
    return NextResponse.json({ error: 'That does not look like an email address' }, { status: 400 });
  }

  // The allowlist is applied here as well as in the form: a non-admin must not be able to
  // subscribe to server-wide events by posting their keys directly.
  const allowed = selectableEvents(session.user.isAdmin, session.user.globalAdmin) as string[];
  const events = (body.events ?? []).filter((event) => allowed.includes(event));
  if (events.length && !address) {
    return NextResponse.json({ error: 'An email address is required' }, { status: 400 });
  }

  // A new address that is not the account's own is confirmed by mail first; the events are
  // saved right away and keep going to the previous address until then.
  const unchanged = !address || isOwnAddress(session.user.notifyEmail, address) || isOwnAddress(session.user.email, address);
  if (unchanged) {
    await setUserPrefs(session.user.id, { email: address, events });
    return NextResponse.json({ ok: true });
  }
  await setUserPrefs(session.user.id, { email: session.user.notifyEmail, events });
  const t = await getT();
  const sent = await sendConfirmation(request, session.user.id, address, 'notify', {
    subject: t('mail.confirmSubject'),
    body: t('mail.confirmNotify'),
    button: t('mail.confirmButton'),
  });
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 400 });
  return NextResponse.json({ ok: true, pending: true });
}
