'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LOCALES, LOCALE_NAMES } from '@/i18n';
import { useT } from '@/i18n/client';
import { FEATURE_FLAGS, isEnabled, NOTIFICATION_EVENTS } from '@/server/features';

/**
 * Puts a React node where a translated string has a placeholder. Keeps a sentence that
 * contains a link or a piece of code as one translatable unit instead of splitting it into
 * fragments a translator cannot reorder.
 */
function splice(text: string, token: string, node: React.ReactNode) {
  const [before, after = ''] = text.split(token);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

export default function ConfigForm({
  hasTmdbKey,
  defaultLocale,
  features,
  watchedThreshold,
  webhookUrl,
  webhookEvents,
  geoipEnabled,
  geoipUrl,
  monitorMaxStreamsPerUser,
  monitorBandwidthMbps,
  monitorTranscodeAlert,
  monitorFailedLoginThreshold,
  monitorFailedLoginWindowMin,
  monitorNewAddressAlert,
  digestEnabled,
  digestFrequency,
  backupAutoEnabled,
  backupIntervalHours,
  backupRetention,
}: {
  hasTmdbKey: boolean;
  defaultLocale: string;
  features: Record<string, boolean>;
  watchedThreshold: number;
  webhookUrl: string | null;
  webhookEvents: string[];
  geoipEnabled: boolean;
  geoipUrl: string | null;
  monitorMaxStreamsPerUser: number | null;
  monitorBandwidthMbps: number | null;
  monitorTranscodeAlert: boolean;
  monitorFailedLoginThreshold: number | null;
  monitorFailedLoginWindowMin: number;
  monitorNewAddressAlert: boolean;
  digestEnabled: boolean;
  digestFrequency: string;
  backupAutoEnabled: boolean;
  backupIntervalHours: number;
  backupRetention: number;
}) {
  const router = useRouter();
  const t = useT();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onTestWebhook() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await fetch('/api/admin/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'webhook' }),
    });
    setBusy(false);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (res.ok && body.ok) setMessage(t('config.testSent'));
    else setError(body.error ?? t('config.testFailed'));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    const form = new FormData(event.currentTarget);
    const body = {
      watchedThreshold: Number(form.get('watchedThreshold') ?? 85),
      webhookUrl: String(form.get('webhookUrl') ?? ''),
      webhookEvents: NOTIFICATION_EVENTS.filter((e) => form.get(`event.${e.key}`) === 'on').map(
        (e) => e.key,
      ),
      geoipEnabled: form.get('geoipEnabled') === 'on',
      geoipUrl: String(form.get('geoipUrl') ?? ''),
      tmdbApiKey: form.get('clearTmdb') ? '' : String(form.get('tmdbApiKey') ?? '') || undefined,
      defaultLocale: String(form.get('defaultLocale') ?? ''),
      features: Object.fromEntries(
        FEATURE_FLAGS.map((flag) => [flag.key, form.get(`feature.${flag.key}`) === 'on']),
      ),
      monitorMaxStreamsPerUser: form.get('monitorMaxStreamsPerUser')
        ? Number(form.get('monitorMaxStreamsPerUser'))
        : null,
      monitorBandwidthMbps: form.get('monitorBandwidthMbps')
        ? Number(form.get('monitorBandwidthMbps'))
        : null,
      monitorTranscodeAlert: form.get('monitorTranscodeAlert') === 'on',
      monitorFailedLoginThreshold: form.get('monitorFailedLoginThreshold')
        ? Number(form.get('monitorFailedLoginThreshold'))
        : null,
      monitorFailedLoginWindowMin: Number(form.get('monitorFailedLoginWindowMin') ?? 10),
      monitorNewAddressAlert: form.get('monitorNewAddressAlert') === 'on',
      digestEnabled: form.get('digestEnabled') === 'on',
      digestFrequency: String(form.get('digestFrequency') ?? 'weekly'),
      backupAutoEnabled: form.get('backupAutoEnabled') === 'on',
      backupIntervalHours: Number(form.get('backupIntervalHours') ?? 24),
      backupRetention: Number(form.get('backupRetention') ?? 7),
    };

    const res = await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) {
      setMessage(t('action.saved'));
      router.refresh();
    } else {
      setError(((await res.json()) as { error?: string }).error ?? t('config.saveFailed'));
    }
  }

  return (
    <form className="card" onSubmit={onSubmit} style={{ maxWidth: 520 }}>
      <label>
        {t('config.defaultLanguage')}
        <select name="defaultLocale" defaultValue={defaultLocale}>
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted" style={{ marginTop: -8 }}>
        {t('config.defaultLanguageHint')}
      </p>

      <label>
        {t('config.tmdbKey')}
        <input
          name="tmdbApiKey"
          type="password"
          placeholder={hasTmdbKey ? t('config.configured') : t('config.notSet')}
        />
      </label>
      {hasTmdbKey && (
        <label className="row">
          <input type="checkbox" name="clearTmdb" style={{ width: 'auto' }} />{' '}
          {t('config.clearTmdb')}
        </label>
      )}

      <label>
        {t('config.watchedThreshold')}
        <input
          name="watchedThreshold"
          type="number"
          min={1}
          max={100}
          defaultValue={watchedThreshold}
          required
        />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        {t('config.watchedThresholdHint')}
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('config.features')}
      </p>
      {FEATURE_FLAGS.map((flag) => (
        <label className="row" key={flag.key}>
          <input
            type="checkbox"
            name={`feature.${flag.key}`}
            defaultChecked={isEnabled(features, flag.key)}
            style={{ width: 'auto' }}
          />
          {t(flag.labelKey)}
        </label>
      ))}

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('config.genericWebhook')}
      </p>
      <label>
        {t('config.endpointUrl')}
        <input name="webhookUrl" type="url" defaultValue={webhookUrl ?? ''} placeholder="https://" />
      </label>
      {webhookUrl && (
        <button type="button" className="outlined" disabled={busy} onClick={onTestWebhook}>
          {t('config.sendTest')}
        </button>
      )}
      <p className="muted" style={{ marginTop: -6 }}>
        {splice(
          t('config.webhookHint'),
          '{link}',
          <a href="/admin/notifications">{t('config.notificationsLink')}</a>,
        )}
      </p>
      {NOTIFICATION_EVENTS.map((event) => (
        <label className="row" key={event.key}>
          <input
            type="checkbox"
            name={`event.${event.key}`}
            defaultChecked={webhookEvents.includes(event.key)}
            style={{ width: 'auto' }}
          />
          {t(event.labelKey)}
        </label>
      ))}

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('config.monitoring')}
      </p>
      <label>
        {t('config.maxStreamsPerUser')}
        <input
          name="monitorMaxStreamsPerUser"
          type="number"
          min={1}
          defaultValue={monitorMaxStreamsPerUser ?? ''}
          placeholder={t('config.off')}
        />
      </label>
      <label>
        {t('config.bandwidthAlert')}
        <input
          name="monitorBandwidthMbps"
          type="number"
          min={1}
          defaultValue={monitorBandwidthMbps ?? ''}
          placeholder={t('config.off')}
        />
      </label>
      <label className="row">
        <input
          type="checkbox"
          name="monitorTranscodeAlert"
          defaultChecked={monitorTranscodeAlert}
          style={{ width: 'auto' }}
        />
        {t('config.transcodeAlert')}
      </label>
      <label>
        {t('config.failedLogins')}
        <input
          name="monitorFailedLoginThreshold"
          type="number"
          min={1}
          defaultValue={monitorFailedLoginThreshold ?? ''}
          placeholder={t('config.off')}
        />
      </label>
      <label>
        {t('config.failedLoginWindow')}
        <input
          name="monitorFailedLoginWindowMin"
          type="number"
          min={1}
          defaultValue={monitorFailedLoginWindowMin}
        />
      </label>
      <label className="row">
        <input
          type="checkbox"
          name="monitorNewAddressAlert"
          defaultChecked={monitorNewAddressAlert}
        />
        {t('config.newAddressAlert')}
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        {t('config.monitoringHint')}
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('config.digest')}
      </p>
      <label className="row">
        <input
          type="checkbox"
          name="digestEnabled"
          defaultChecked={digestEnabled}
          style={{ width: 'auto' }}
        />
        {t('config.digestEnabled')}
      </label>
      <label>
        {t('config.frequency')}
        <select name="digestFrequency" defaultValue={digestFrequency}>
          <option value="daily">{t('config.daily')}</option>
          <option value="weekly">{t('config.weekly')}</option>
        </select>
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        {splice(t('config.digestHint'), '{code}', <code>digest</code>)}
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('config.backups')}
      </p>
      <label className="row">
        <input
          type="checkbox"
          name="backupAutoEnabled"
          defaultChecked={backupAutoEnabled}
          style={{ width: 'auto' }}
        />
        {t('config.backupEnabled')}
      </label>
      <label>
        {t('config.backupInterval')}
        <input name="backupIntervalHours" type="number" min={1} defaultValue={backupIntervalHours} />
      </label>
      <label>
        {t('config.backupRetention')}
        <input name="backupRetention" type="number" min={1} defaultValue={backupRetention} />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        {splice(
          t('config.backupHint'),
          '{link}',
          <a href="/admin/system">{t('config.system')}</a>,
        )}
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('config.geoip')}
      </p>
      <label className="row">
        <input
          type="checkbox"
          name="geoipEnabled"
          defaultChecked={geoipEnabled}
          style={{ width: 'auto' }}
        />
        {t('config.geoipEnabled')}
      </label>
      <label>
        {t('config.geoipUrl')}
        <input
          name="geoipUrl"
          type="url"
          defaultValue={geoipUrl ?? ''}
          placeholder="https://ipapi.co/{ip}/json/"
        />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        {t('config.geoipHint')}
      </p>

      <button disabled={busy} style={{ marginTop: 16 }}>
        {t('action.save')}
      </button>
      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
