import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { isLocale } from '@/i18n';
import { getDefaultLocale } from '@/i18n/server';
import { getSettings } from '@/server/config';
import { collectNewsletter, renderNewsletter } from '@/server/newsletter';
import { sendMail } from '@/server/notifications';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sends one issue to one address — the admin's own by default — without touching the stored issue. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = await readBody(request, { email: 'string', locale: 'string' });
  if (!body) return badBody();

  const to = (body.email ?? session.user.email ?? '').trim();
  if (!EMAIL.test(to)) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 });
  }

  const locale = isLocale(body.locale) ? body.locale : await getDefaultLocale();
  const settings = await getSettings();
  const html = await renderNewsletter(await collectNewsletter(), locale);
  const result = await sendMail([to], `[Test] ${settings.newsletterSubject}`, html);
  return result.ok
    ? NextResponse.json({ ok: true, to })
    : NextResponse.json({ error: result.error ?? 'Could not send' }, { status: 502 });
}
