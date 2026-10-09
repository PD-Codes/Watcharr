import { formatDate } from '@/components/format';
import { getSettings, listServers } from '@/server/config';
import { getSections, sectionKey } from '@/server/library';
import { listChannels } from '@/server/notifications';
import { listSubscribers, normalizeLibraries } from '@/server/newsletter';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import NewsletterForm, { type LibraryOption } from './NewsletterForm';

export const dynamic = 'force-dynamic';

export default async function AdminNewsletterPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const [settings, subscribers, channels, servers] = await Promise.all([
    getSettings(),
    listSubscribers(),
    listChannels(),
    listServers(),
  ]);

  // Sections from every configured server, keyed with the server so two servers cannot collide
  // on an id (Plex numbers its libraries per server).
  const libraries: LibraryOption[] = (
    await Promise.all(
      servers.map(async (server) => {
        const sections = await getSections(server.id).catch(() => []);
        return sections.map((section) => ({
          id: sectionKey(server.id, section.id),
          name: servers.length > 1 ? `${server.label} · ${section.name}` : section.name,
        }));
      }),
    )
  ).flat();

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminNewsletter')}</h1>
      <p className="subtitle">{t('adminNewsletter.subtitle')}</p>

      <NewsletterForm
        enabled={settings.newsletterEnabled}
        dayOfWeek={settings.newsletterDayOfWeek}
        hour={settings.newsletterHour}
        days={settings.newsletterDays}
        libraries={libraries}
        selectedLibraries={normalizeLibraries(
          settings.newsletterLibraries,
          servers.map((server) => server.id),
        )}
        subject={settings.newsletterSubject}
        intro={settings.newsletterIntro}
        uniqueId={settings.newsletterUniqueId}
        subscriberCount={subscribers.length}
        hasEmailChannel={channels.some((c) => c.type === 'email' && c.enabled)}
      />

      <h2 className="section">{t('adminNewsletter.subscribers')}</h2>
      <p className="subtitle" style={{ marginTop: -8 }}>
        {settings.newsletterLastSentAt
          ? t('adminNewsletter.lastSent', { date: formatDate(settings.newsletterLastSentAt) })
          : t('adminNewsletter.noneSent')}
      </p>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('common.user')}</th>
              <th>{t('adminNewsletter.colDeliversTo')}</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map((row) => (
              <tr key={row.userId}>
                <td>{row.username}</td>
                <td className="muted">{row.email}</td>
              </tr>
            ))}
            {subscribers.length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
                  {t('adminNewsletter.noSubscribers')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
