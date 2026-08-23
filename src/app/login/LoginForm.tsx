'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@/i18n';

/** Credential login for Jellyfin and Emby. */
export default function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(form)),
    });
    setBusy(false);
    if (res.ok) router.push('/watchlist');
    else setError(((await res.json()) as { error?: string }).error ?? 'Login failed');
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
      <button disabled={busy}>{t('action.signIn')}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
