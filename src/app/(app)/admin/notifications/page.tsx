import { formatDate } from '@/components/format';
import { CHANNEL_TYPES, NOTIFICATION_EVENTS } from '@/server/features';
import { listChannels, listNotificationLog } from '@/server/notifications';
import { requireGlobalAdmin } from '@/server/session';
import NotificationsManager from './NotificationsManager';

export const dynamic = 'force-dynamic';

export default async function AdminNotificationsPage() {
  await requireGlobalAdmin();
  const [channels, log] = await Promise.all([listChannels(), listNotificationLog(50)]);

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Notifications</h1>
      <p className="subtitle">
        Destinations for playback, server and monitoring events, on top of the generic
        webhook on <a href="/admin/config">Settings</a>.
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

      <h2 className="section">Delivery log</h2>
      <p className="subtitle" style={{ marginTop: -8 }}>
        Every attempt, successful or not — a channel that silently stopped working shows up
        here instead of vanishing after its one retry.
      </p>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Channel</th>
              <th>Event</th>
              <th>Result</th>
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
                  {entry.success ? 'Delivered' : (entry.error ?? 'Failed')}
                </td>
              </tr>
            ))}
            {log.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No notifications sent yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
