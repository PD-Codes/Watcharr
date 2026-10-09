'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

/** Credential login for Jellyfin and Emby. */
export default function LoginForm({ serverId, askSetupToken }: { serverId: number; askSetupToken?: boolean }) {
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
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...Object.fromEntries(form), serverId }),
      });
      if (res.ok) router.push('/watchlist');
      else {
        const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        setError(data.code === 'setup-token' ? t('login.setupTokenInvalid') : (data.error ?? t('login.failed')));
      }
    } catch {
      setError(t('login.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        {t('login.username')}
        <input name="username" autoComplete="username" required />
      </label>
      <label>
        {t('login.password')}
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {askSetupToken && (
        <label>
          {t('login.setupToken')}
          <input name="setupToken" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX" />
          <span className="muted">{t('login.setupTokenHint')}</span>
        </label>
      )}
      <button disabled={busy}>{t('action.signIn')}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
