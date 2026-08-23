'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FEATURE_FLAGS, isEnabled } from '@/server/features';

export default function ConfigForm({
  serverUrl,
  hasTmdbKey,
  features,
}: {
  serverUrl: string;
  hasTmdbKey: boolean;
  features: Record<string, boolean>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    const form = new FormData(event.currentTarget);
    const body = {
      serverUrl: String(form.get('serverUrl') ?? ''),
      serverToken: String(form.get('serverToken') ?? '') || undefined,
      tmdbApiKey: form.get('clearTmdb') ? '' : String(form.get('tmdbApiKey') ?? '') || undefined,
      features: Object.fromEntries(
        FEATURE_FLAGS.map((flag) => [flag.key, form.get(`feature.${flag.key}`) === 'on']),
      ),
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
        Server URL
        <input name="serverUrl" defaultValue={serverUrl} required />
      </label>
      <label>
        Admin API token
        <input name="serverToken" type="password" placeholder="unchanged" />
      </label>
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

      <button disabled={busy} style={{ marginTop: 16 }}>
        Save
      </button>
      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
