import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { isLocale } from '@/i18n';
import { getDefaultLocale } from '@/i18n/server';
import { getSettings } from '@/server/config';
import { collectNewsletter, renderNewsletter } from '@/server/newsletter';
import { sendMail } from '@/server/notifications';
import { getSession } from '@/server/session';
import { apiError, badBody, globalAdminRequired, withApiErrors } from '@/server/apierror';

export const dynamic = 'force-dynamic';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sends one issue to one address — the admin's own by default — without touching the stored issue. */
export const POST = withApiErrors(async (request: Request) => {
  const session = await getSession();
  if (!session?.user.globalAdmin) return globalAdminRequired();
  const body = await readBody(request, { email: 'string', locale: 'string' });
  if (!body) return badBody();

  const to = (body.email ?? session.user.email ?? '').trim();
  if (!EMAIL.test(to)) {
    return apiError(400, 'invalid-email', 'err.invalidEmail');
  }

  const locale = isLocale(body.locale) ? body.locale : await getDefaultLocale();
  const settings = await getSettings();
  const html = await renderNewsletter(await collectNewsletter(), locale);
  const result = await sendMail([to], `[Test] ${settings.newsletterSubject}`, html);
  return result.ok
    ? NextResponse.json({ ok: true, to })
    : apiError(502, 'send-failed', 'err.sendFailed', { message: result.error });
});
