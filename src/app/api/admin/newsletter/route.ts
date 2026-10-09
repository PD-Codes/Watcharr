import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { updateSettings } from '@/server/config';
import { sendNewsletter } from '@/server/newsletter';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

async function requireGlobal() {
  const session = await getSession();
  return session?.user.globalAdmin ? session : null;
}

/** Newsletter configuration. Subscriptions are the users' own, see /api/newsletter. */
export async function POST(request: Request) {
  if (!(await requireGlobal())) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const body = await readBody(request, {
    enabled: 'boolean',
    dayOfWeek: 'number',
    hour: 'number',
    days: 'number',
    libraries: 'strings',
    subject: 'string',
    intro: 'string',
    uniqueId: 'string',
    sendNow: 'boolean',
  });
  if (!body) return badBody();

  // A test send must not silently use settings the admin has not saved yet, so the config
  // is written first and the send picks it up from there.
  await updateSettings({
    newsletterEnabled: body.enabled ?? undefined,
    newsletterDayOfWeek: body.dayOfWeek ?? undefined,
    newsletterHour: body.hour ?? undefined,
    newsletterDays: body.days ?? undefined,
    newsletterLibraries: body.libraries ?? undefined,
    newsletterSubject: body.subject ?? undefined,
    newsletterIntro: body.intro ?? undefined,
    newsletterUniqueId: body.uniqueId ?? undefined,
  });

  if (body.sendNow) {
    const result = await sendNewsletter();
    return NextResponse.json(
      result.ok ? { ok: true, sent: result.sent } : { error: result.error ?? 'Could not send' },
    );
  }
  return NextResponse.json({ ok: true });
}
