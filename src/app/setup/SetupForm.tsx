'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

export default function SetupForm() {
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      if (res.ok) router.push('/login');
      else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? t('setup.failed'));
      }
    } catch {
      setError(t('setup.failed'));
    } finally {
      setBusy(false);
    }
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
          {t('login.setupToken')}
          <input name="setupToken" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX" required />
          <span className="muted">{t('setup.tokenHint')}</span>
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
