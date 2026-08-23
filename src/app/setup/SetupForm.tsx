'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@/i18n';

export default function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(form)),
    });
    setBusy(false);
    if (res.ok) router.push('/login');
    else setError(((await res.json()) as { error?: string }).error ?? 'Setup failed');
  }

  return (
    <div className="center card">
      <h1>{t('setup.title')}</h1>
      <p className="muted">{t('setup.intro')}</p>
      <form onSubmit={onSubmit}>
        <label>
          {t('setup.serverType')}
          <select name="serverType" defaultValue="jellyfin">
            <option value="plex">Plex</option>
            <option value="jellyfin">Jellyfin</option>
            <option value="emby">Emby</option>
          </select>
        </label>
        <label>
          {t('setup.serverUrl')}
          <input name="serverUrl" placeholder="http://192.168.1.10:8096" required />
        </label>
        <label>
          {t('setup.serverToken')}
          <input name="serverToken" type="password" required />
        </label>
        <label>
          {t('setup.tmdbKey')}
          <input name="tmdbApiKey" type="password" />
        </label>
        <button disabled={busy}>{t('setup.submit')}</button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
