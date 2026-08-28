import { getSettings } from '@/server/config';
import { getSubscription } from '@/server/newsletter';
import { getUserPrefs, listChannels, selectableEvents } from '@/server/notifications';
import { requireUser } from '@/server/session';
import type { Translate, TranslationKey } from '@/i18n';
import { getT } from '@/i18n/server';
import EventPrefs from './EventPrefs';
import NewsletterSubscription from './NewsletterSubscription';

export const dynamic = 'force-dynamic';

// Everything a user decides for themselves about being contacted, in one place: the
// recently-added newsletter and the events they want mailed. The admin counterpart lives
// under /admin/notifications and owns the deployment-wide channels instead.

// Sunday first, matching JavaScript's own weekday numbering used by the newsletter schedule.
const DAY_KEYS: TranslationKey[] = [
  'weekday.sunday',
  'weekday.monday',
  'weekday.tuesday',
  'weekday.wednesday',
  'weekday.thursday',
  'weekday.friday',
  'weekday.saturday',
];

function scheduleHint(t: Translate, settings: Awaited<ReturnType<typeof getSettings>>): string {
  return settings.newsletterEnabled
    ? t('profile.nlSchedule', {
        weekday: t(DAY_KEYS[settings.newsletterDayOfWeek]),
        hour: String(settings.newsletterHour).padStart(2, '0'),
        days: settings.newsletterDays,
      })
    : t('profile.nlOff');
}

export default async function NotificationsPage() {
  const { user } = await requireUser();
  const t = await getT();
  const settings = await getSettings();
  const subscription = await getSubscription(user.id);
  const prefs = await getUserPrefs(user.id);
  const mailConfigured = (await listChannels().catch(() => [])).some(
    (channel) => channel.type === 'email' && channel.enabled,
  );

  return (
    <>
      <p className="eyebrow">{user.username}</p>
      <h1>{t('nav.notifications')}</h1>
      <p className="subtitle">{t('notifyMe.subtitle')}</p>

      <section>
        <EventPrefs
          email={prefs.email}
          suggestedEmail={user.email ?? ''}
          events={prefs.events}
          selectable={selectableEvents(user.isAdmin || user.globalAdmin)}
          mailConfigured={mailConfigured}
        />
      </section>

      <section>
        <NewsletterSubscription
          subscribedEmail={subscription?.email ?? null}
          suggestedEmail={user.email ?? ''}
          scheduleHint={scheduleHint(t, settings)}
        />
      </section>
    </>
  );
}
