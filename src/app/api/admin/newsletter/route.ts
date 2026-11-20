import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { updateSettings } from '@/server/config';
import { sendNewsletter } from '@/server/newsletter';
import { getGlobalAdminSession } from '@/server/session';
import { apiError, badBody, globalAdminRequired, withApiErrors } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/** Newsletter configuration. Subscriptions are the users' own, see /api/newsletter. */
export const POST = withApiErrors(async (request: Request) => {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();

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
    // 200 either way, as before: the settings were saved, only the send failed.
    return result.ok
      ? NextResponse.json({ ok: true, sent: result.sent })
      : apiError(200, 'send-failed', 'err.sendFailed', { message: result.error });
  }
  return NextResponse.json({ ok: true });
});
