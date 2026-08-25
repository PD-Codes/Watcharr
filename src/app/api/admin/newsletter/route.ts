import { NextResponse } from 'next/server';
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

  const body = (await request.json()) as {
    enabled?: boolean;
    dayOfWeek?: number;
    hour?: number;
    days?: number;
    libraries?: string[];
    subject?: string;
    intro?: string;
    uniqueId?: string;
    sendNow?: boolean;
  };

  // A test send must not silently use settings the admin has not saved yet, so the config
  // is written first and the send picks it up from there.
  await updateSettings({
    newsletterEnabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    newsletterDayOfWeek: body.dayOfWeek,
    newsletterHour: body.hour,
    newsletterDays: body.days,
    newsletterLibraries: Array.isArray(body.libraries)
      ? body.libraries.filter((id): id is string => typeof id === 'string')
      : undefined,
    newsletterSubject: body.subject,
    newsletterIntro: body.intro,
    newsletterUniqueId: body.uniqueId,
  });

  if (body.sendNow) {
    const result = await sendNewsletter();
    return NextResponse.json(
      result.ok ? { ok: true, sent: result.sent } : { error: result.error ?? 'Could not send' },
    );
  }
  return NextResponse.json({ ok: true });
}
