import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { getT } from '@/i18n/server';
import { isOwnAddress, sendConfirmation } from '@/server/mailconfirm';
import { getSubscription, subscribe, unsubscribe } from '@/server/newsletter';
import { getSession } from '@/server/session';
import { apiError, badBody, unauthorized, withApiErrors } from '@/server/apierror';

export const dynamic = 'force-dynamic';

// Deliberately not admin-gated and deliberately keyed off the session rather than a user
// id in the body: a subscription is the user's own, and nobody signs anybody else up.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const POST = withApiErrors(async (request: Request) => {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await readBody(request, { email: 'string' });
  if (!body) return badBody();
  const address = body.email?.trim() ?? '';
  if (!EMAIL.test(address)) {
    return apiError(400, 'invalid-email', 'err.invalidEmail');
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
  if (!sent.ok) return apiError(sent.status ?? 400, 'confirm-failed', 'err.sendFailed', { message: sent.error });
  return NextResponse.json({ ok: true, pending: true });
});

export async function DELETE() {
  const session = await getSession();
  if (!session) return unauthorized();

  await unsubscribe(session.user.id);
  return NextResponse.json({ ok: true });
}
