import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { isLocale } from '@/i18n';
import { getDefaultLocale } from '@/i18n/server';
import { collectNewsletter, renderNewsletter, subscriberLocales } from '@/server/newsletter';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Renders the issue exactly as it would go out now, from the form's unsaved values, and sends
 * nothing. The page shows the HTML in a sandboxed iframe, so a hostile title cannot run.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = await readBody(request, {
    days: 'number',
    libraries: 'strings',
    subject: 'string',
    intro: 'string',
    locale: 'string',
  });
  if (!body) return badBody();

  const draft = {
    days: body.days != null ? Math.min(90, Math.max(1, Math.round(body.days))) : undefined,
    libraries: body.libraries ?? undefined,
    subject: body.subject ?? undefined,
    intro: body.intro ?? undefined,
  };
  const locale = isLocale(body.locale) ? body.locale : await getDefaultLocale();
  const entries = await collectNewsletter(draft);
  return NextResponse.json({
    html: await renderNewsletter(entries, locale, draft),
    items: entries.reduce((sum, entry) => sum + entry.items.length, 0),
    locales: await subscriberLocales(),
    locale,
  });
}
