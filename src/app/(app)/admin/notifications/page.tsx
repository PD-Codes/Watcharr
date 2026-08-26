import { formatDate } from '@/components/format';
import { CHANNEL_TYPES, NOTIFICATION_EVENTS } from '@/server/features';
import { listChannels, listNotificationLog } from '@/server/notifications';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import NotificationsManager from './NotificationsManager';

export const dynamic = 'force-dynamic';

export default async function AdminNotificationsPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const [channels, log] = await Promise.all([listChannels(), listNotificationLog(50)]);

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
          enabled: c.enabled,
        }))}
        channelTypes={CHANNEL_TYPES}
        events={NOTIFICATION_EVENTS}
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
