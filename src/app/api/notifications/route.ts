import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { getT } from '@/i18n/server';
import { isOwnAddress, sendConfirmation } from '@/server/mailconfirm';
import { selectableEvents, setUserPrefs } from '@/server/notifications';
import { getSession } from '@/server/session';
import { apiError, badBody, unauthorized, withApiErrors } from '@/server/apierror';

export const dynamic = 'force-dynamic';

// Keyed off the session, never off a user id in the body: these are the caller's own
// notifications, the same rule the newsletter route follows.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const POST = withApiErrors(async (request: Request) => {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await readBody(request, { email: 'string', events: 'strings' });
  if (!body) return badBody();
  const address = body.email?.trim() || null;
  if (address && !EMAIL.test(address)) {
    return apiError(400, 'invalid-email', 'err.invalidEmail');
  }

  // The allowlist is applied here as well as in the form: a non-admin must not be able to
  // subscribe to server-wide events by posting their keys directly.
  const allowed = selectableEvents(session.user.isAdmin, session.user.globalAdmin) as string[];
  const events = (body.events ?? []).filter((event) => allowed.includes(event));
  if (events.length && !address) {
    return apiError(400, 'email-required', 'err.emailRequired');
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
  if (!sent.ok) return apiError(sent.status ?? 400, 'confirm-failed', 'err.sendFailed', { message: sent.error });
  return NextResponse.json({ ok: true, pending: true });
});
