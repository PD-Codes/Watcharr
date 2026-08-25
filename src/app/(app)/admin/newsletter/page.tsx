import { formatDate } from '@/components/format';
import { getAdapter, getSettings, listServers } from '@/server/config';
import { listChannels } from '@/server/notifications';
import { listSubscribers } from '@/server/newsletter';
import { requireGlobalAdmin } from '@/server/session';
import NewsletterForm, { type LibraryOption } from './NewsletterForm';

export const dynamic = 'force-dynamic';

export default async function AdminNewsletterPage() {
  await requireGlobalAdmin();
  const [settings, subscribers, channels, servers] = await Promise.all([
    getSettings(),
    listSubscribers(),
    listChannels(),
    listServers(),
  ]);

  // Sections from every configured server, prefixed so two servers cannot collide on an id.
  const libraries: LibraryOption[] = (
    await Promise.all(
      servers.map(async (server) => {
        const sections = await (await getAdapter(server.id)).getLibraries().catch(() => []);
        return sections.map((section) => ({
          id: section.id,
          name: servers.length > 1 ? `${server.label} · ${section.name}` : section.name,
        }));
      }),
    )
  ).flat();

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Newsletter</h1>
      <p className="subtitle">
        A recently-added digest for the people who asked for it. Delivery uses the SMTP
        settings of the email channel under Notifications.
      </p>

      <NewsletterForm
        enabled={settings.newsletterEnabled}
        dayOfWeek={settings.newsletterDayOfWeek}
        hour={settings.newsletterHour}
        days={settings.newsletterDays}
        libraries={libraries}
        selectedLibraries={settings.newsletterLibraries}
        subject={settings.newsletterSubject}
        intro={settings.newsletterIntro}
        uniqueId={settings.newsletterUniqueId}
        subscriberCount={subscribers.length}
        hasEmailChannel={channels.some((c) => c.type === 'email' && c.enabled)}
      />

      <h2 className="section">Subscribers</h2>
      <p className="subtitle" style={{ marginTop: -8 }}>
        {settings.newsletterLastSentAt
          ? `Last issue sent ${formatDate(settings.newsletterLastSentAt)}.`
          : 'No issue has been sent yet.'}
      </p>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Delivers to</th>
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
                  Nobody has subscribed yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
