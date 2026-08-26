import { formatDate } from '@/components/format';
import { getSettings } from '@/server/config';
import { listAlerts } from '@/server/monitor';
import { requireGlobalAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import ConfigForm from './ConfigForm';

export const dynamic = 'force-dynamic';

export default async function AdminConfigPage() {
  await requireGlobalAdmin();
  const t = await getT();
  const [settings, alerts] = await Promise.all([getSettings(), listAlerts(20)]);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('config.title')}</h1>
      <p className="subtitle">{t('config.subtitle')}</p>
      <ConfigForm
        hasTmdbKey={Boolean(settings.tmdbApiKey)}
        defaultLocale={settings.defaultLocale}
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
        monitorNewAddressAlert={settings.monitorNewAddressAlert}
        digestEnabled={settings.digestEnabled}
        digestFrequency={settings.digestFrequency}
        backupAutoEnabled={settings.backupAutoEnabled}
        backupIntervalHours={settings.backupIntervalHours}
        backupRetention={settings.backupRetention}
      />

      <h2 className="section">{t('config.recentAlerts')}</h2>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('config.colWhen')}</th>
              <th>{t('config.colRule')}</th>
              <th>{t('config.colMessage')}</th>
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
                  {t('config.noAlerts')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
