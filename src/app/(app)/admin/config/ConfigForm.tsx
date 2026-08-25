'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FEATURE_FLAGS, isEnabled, NOTIFICATION_EVENTS } from '@/server/features';

export default function ConfigForm({
  hasTmdbKey,
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
  digestEnabled,
  digestFrequency,
  backupAutoEnabled,
  backupIntervalHours,
  backupRetention,
}: {
  hasTmdbKey: boolean;
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
  digestEnabled: boolean;
  digestFrequency: string;
  backupAutoEnabled: boolean;
  backupIntervalHours: number;
  backupRetention: number;
}) {
  const router = useRouter();
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
    if (res.ok && body.ok) setMessage('Test notification sent.');
    else setError(body.error ?? 'Test failed.');
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
      setMessage('Saved.');
      router.refresh();
    } else {
      setError(((await res.json()) as { error?: string }).error ?? 'Could not save');
    }
  }

  return (
    <form className="card" onSubmit={onSubmit} style={{ maxWidth: 520 }}>
      <label>
        TMDB API key
        <input name="tmdbApiKey" type="password" placeholder={hasTmdbKey ? 'configured' : 'not set'} />
      </label>
      {hasTmdbKey && (
        <label className="row">
          <input type="checkbox" name="clearTmdb" style={{ width: 'auto' }} /> Remove the stored TMDB
          key
        </label>
      )}

      <label>
        Counts as finished from
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
        Percent of the runtime a stream has to reach. Changing it re-labels past sessions
        too, because the split is computed on read.
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        Features
      </p>
      {FEATURE_FLAGS.map((flag) => (
        <label className="row" key={flag.key}>
          <input
            type="checkbox"
            name={`feature.${flag.key}`}
            defaultChecked={isEnabled(features, flag.key)}
            style={{ width: 'auto' }}
          />
          {flag.label}
        </label>
      ))}

      <p className="stat-label" style={{ marginTop: 20 }}>
        Generic webhook
      </p>
      <label>
        Endpoint URL
        <input name="webhookUrl" type="url" defaultValue={webhookUrl ?? ''} placeholder="https://" />
      </label>
      {webhookUrl && (
        <button type="button" className="outlined" disabled={busy} onClick={onTestWebhook}>
          Send test
        </button>
      )}
      <p className="muted" style={{ marginTop: -6 }}>
        Receives a raw JSON POST per event. For ntfy, n8n or anything else that accepts
        arbitrary JSON. Discord, Slack, Telegram, Pushover, Pushbullet and email have their
        own channel types under{' '}
        <a href="/admin/notifications">Notifications</a>, formatted for what each expects.
        Leave empty to send nothing here.
      </p>
      {NOTIFICATION_EVENTS.map((event) => (
        <label className="row" key={event.key}>
          <input
            type="checkbox"
            name={`event.${event.key}`}
            defaultChecked={webhookEvents.includes(event.key)}
            style={{ width: 'auto' }}
          />
          {event.label}
        </label>
      ))}

      <p className="stat-label" style={{ marginTop: 20 }}>
        Monitoring thresholds
      </p>
      <label>
        Max concurrent streams per user
        <input
          name="monitorMaxStreamsPerUser"
          type="number"
          min={1}
          defaultValue={monitorMaxStreamsPerUser ?? ''}
          placeholder="off"
        />
      </label>
      <label>
        Bandwidth alert (Mbps, total)
        <input
          name="monitorBandwidthMbps"
          type="number"
          min={1}
          defaultValue={monitorBandwidthMbps ?? ''}
          placeholder="off"
        />
      </label>
      <label className="row">
        <input
          type="checkbox"
          name="monitorTranscodeAlert"
          defaultChecked={monitorTranscodeAlert}
          style={{ width: 'auto' }}
        />
        Alert while any stream is transcoding
      </label>
      <label>
        Failed logins per IP
        <input
          name="monitorFailedLoginThreshold"
          type="number"
          min={1}
          defaultValue={monitorFailedLoginThreshold ?? ''}
          placeholder="off"
        />
      </label>
      <label>
        within (minutes)
        <input
          name="monitorFailedLoginWindowMin"
          type="number"
          min={1}
          defaultValue={monitorFailedLoginWindowMin}
        />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        Checked on every activity poll. Firing sends the "monitoring threshold exceeded"
        event above to every subscribed channel, at most once per 15 minutes per rule.
        Leave a field empty to turn that check off. Recent alerts are listed below.
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        Digest
      </p>
      <label className="row">
        <input
          type="checkbox"
          name="digestEnabled"
          defaultChecked={digestEnabled}
          style={{ width: 'auto' }}
        />
        Send a periodic summary
      </label>
      <label>
        Frequency
        <select name="digestFrequency" defaultValue={digestFrequency}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        Watch time, top titles and active streams over the period, sent as a{' '}
        <code>digest</code> event to every channel subscribed to it — most useful on email.
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        Automatic backups
      </p>
      <label className="row">
        <input
          type="checkbox"
          name="backupAutoEnabled"
          defaultChecked={backupAutoEnabled}
          style={{ width: 'auto' }}
        />
        Keep periodic snapshots on disk
      </label>
      <label>
        Every (hours)
        <input name="backupIntervalHours" type="number" min={1} defaultValue={backupIntervalHours} />
      </label>
      <label>
        Keep last
        <input name="backupRetention" type="number" min={1} defaultValue={backupRetention} />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        Written to data/backups next to the database, oldest deleted once the count above is
        exceeded. Same one-time download as before is still on the{' '}
        <a href="/admin/system">System</a> page.
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        Country lookup
      </p>
      <label className="row">
        <input
          type="checkbox"
          name="geoipEnabled"
          defaultChecked={geoipEnabled}
          style={{ width: 'auto' }}
        />
        Look up the country of remote streams
      </label>
      <label>
        Lookup URL
        <input
          name="geoipUrl"
          type="url"
          defaultValue={geoipUrl ?? ''}
          placeholder="https://ipapi.co/{ip}/json/"
        />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        Off by default, because it sends viewer addresses to a third party. Use {'{ip}'} as
        the placeholder. Local streams are never looked up, and results are cached.
      </p>

      <button disabled={busy} style={{ marginTop: 16 }}>
        Save
      </button>
      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
