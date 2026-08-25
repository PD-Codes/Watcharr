import { formatDate } from '@/components/format';
import { getSettings } from '@/server/config';
import { listAlerts } from '@/server/monitor';
import { requireGlobalAdmin } from '@/server/session';
import ConfigForm from './ConfigForm';

export const dynamic = 'force-dynamic';

export default async function AdminConfigPage() {
  await requireGlobalAdmin();
  const [settings, alerts] = await Promise.all([getSettings(), listAlerts(20)]);

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Settings</h1>
      <p className="subtitle">
        Applies to the whole deployment. Server connections live under Servers.
      </p>
      <ConfigForm
        hasTmdbKey={Boolean(settings.tmdbApiKey)}
        features={settings.features}
        watchedThreshold={settings.watchedThreshold}
        webhookUrl={settings.webhookUrl}
        webhookEvents={settings.webhookEvents}
        geoipEnabled={settings.geoipEnabled}
        geoipUrl={settings.geoipUrl}
        monitorMaxStreamsPerUser={settings.monitorMaxStreamsPerUser}
        monitorBandwidthMbps={settings.monitorBandwidthMbps}
        monitorTranscodeAlert={settings.monitorTranscodeAlert}
        monitorFailedLoginThreshold={settings.monitorFailedLoginThreshold}
        monitorFailedLoginWindowMin={settings.monitorFailedLoginWindowMin}
        digestEnabled={settings.digestEnabled}
        digestFrequency={settings.digestFrequency}
        backupAutoEnabled={settings.backupAutoEnabled}
        backupIntervalHours={settings.backupIntervalHours}
        backupRetention={settings.backupRetention}
      />

      <h2 className="section">Recent alerts</h2>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Rule</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr key={alert.id}>
                <td>{formatDate(alert.createdAt)}</td>
                <td>{alert.rule}</td>
                <td>{alert.message}</td>
              </tr>
            ))}
            {alerts.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No thresholds have fired yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
