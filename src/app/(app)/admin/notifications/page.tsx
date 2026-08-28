import { formatDate } from '@/components/format';
import { listServers } from '@/server/config';
import { CHANNEL_TYPES, NOTIFICATION_EVENTS } from '@/server/features';
import { getSections, sectionKey } from '@/server/library';
import { listChannels, listNotificationLog } from '@/server/notifications';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import NotificationsManager from './NotificationsManager';

export const dynamic = 'force-dynamic';

/**
 * Every library across every server, as the keys a condition stores. Failing servers are
 * skipped rather than taking the page down — a channel form is still editable when one
 * media server is unreachable, and the saved keys survive whether or not it answered.
 */
async function libraryOptions(): Promise<{ key: string; label: string }[]> {
  const servers = await listServers();
  const perServer = await Promise.all(
    servers.map(async (server) => {
      const sections = await getSections(server.id).catch(() => []);
      return sections.map((section) => ({
        key: sectionKey(server.id, section.id),
        // The server is named only when there is more than one, the same rule the sign-in
        // page follows: a single-server install should not read as if it had a choice.
        label: servers.length > 1 ? `${server.label} — ${section.name}` : section.name,
      }));
    }),
  );
  return perServer.flat();
}

export default async function AdminNotificationsPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const [channels, log, libraries] = await Promise.all([
    listChannels(),
    listNotificationLog(50),
    libraryOptions(),
  ]);

  // The link is spliced into the translated sentence so the whole subtitle stays one key.
  const [subtitleBefore, subtitleAfter = ''] = t('notifications.subtitle').split('{link}');

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminNotifications')}</h1>
      <p className="subtitle">
        {subtitleBefore}
        <a href="/admin/config">{t('notifications.settingsLink')}</a>
        {subtitleAfter}
      </p>

      <NotificationsManager
        channels={channels.map((c) => ({
          id: c.id,
          type: c.type,
          name: c.name,
          configuredFields: c.configuredFields,
          events: c.events,
          conditions: c.conditions,
          template: c.template,
          enabled: c.enabled,
        }))}
        channelTypes={CHANNEL_TYPES}
        events={NOTIFICATION_EVENTS}
        libraries={libraries}
      />

      <h2 className="section">{t('notifications.log')}</h2>
      <p className="subtitle" style={{ marginTop: -8 }}>
        {t('notifications.logSubtitle')}
      </p>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('notifications.colWhen')}</th>
              <th>{t('notifications.colChannel')}</th>
              <th>{t('notifications.colEvent')}</th>
              <th>{t('notifications.colResult')}</th>
            </tr>
          </thead>
          <tbody>
            {log.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDate(entry.createdAt)}</td>
                <td>
                  {entry.channelName || entry.channelType} · {entry.channelType}
                </td>
                <td>{entry.event}</td>
                <td className={entry.success ? undefined : 'error'}>
                  {entry.success
                    ? t('notifications.delivered')
                    : (entry.error ?? t('notifications.failed'))}
                </td>
              </tr>
            ))}
            {log.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {t('notifications.logEmpty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
