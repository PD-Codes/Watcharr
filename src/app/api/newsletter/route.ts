import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { getT } from '@/i18n/server';
import { isOwnAddress, sendConfirmation } from '@/server/mailconfirm';
import { getSubscription, subscribe, unsubscribe } from '@/server/newsletter';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

// Deliberately not admin-gated and deliberately keyed off the session rather than a user
// id in the body: a subscription is the user's own, and nobody signs anybody else up.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  const body = await readBody(request, { email: 'string' });
  if (!body) return badBody();
  const address = body.email?.trim() ?? '';
  if (!EMAIL.test(address)) {
    return NextResponse.json({ error: 'That does not look like an email address' }, { status: 400 });
  }

  // The account's own address, or the one already confirmed, needs no round trip.
  const current = await getSubscription(session.user.id);
  if (isOwnAddress(session.user.email, address) || isOwnAddress(current?.email, address)) {
    await subscribe(session.user.id, address);
    return NextResponse.json({ ok: true });
  }
  const t = await getT();
  const sent = await sendConfirmation(request, session.user.id, address, 'newsletter', {
    subject: t('mail.confirmSubject'),
    body: t('mail.confirmNewsletter'),
    button: t('mail.confirmButton'),
  });
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 400 });
  return NextResponse.json({ ok: true, pending: true });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  await unsubscribe(session.user.id);
  return NextResponse.json({ ok: true });
}
