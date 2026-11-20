'use client';

import { useState } from 'react';
import { useT } from '@/i18n/client';

/** Asks for a console code and redeems it. A full reload afterwards: the shell reads the new session. */
export default function AdminLogin({ initialCode }: { initialCode: string }) {
  const t = useT();
  const [code, setCode] = useState(initialCode);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(url: string, body?: unknown) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    return { ok: res.ok, code: data.code };
  }

  async function requestCode() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await post('/api/auth/admin-recovery/request');
      if (res.ok) setNotice(t('adminlogin.requested'));
      else setError(res.code === 'limited' ? t('adminlogin.limited') : t('adminlogin.failed'));
    } catch {
      setError(t('adminlogin.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post('/api/auth/admin-recovery', { code });
      if (res.ok) {
        window.location.assign('/admin/servers');
        return;
      }
      setError(
        res.code === 'limited'
          ? t('adminlogin.limited')
          : res.code === 'invalid'
            ? t('adminlogin.invalid')
            : t('adminlogin.failed'),
      );
    } catch {
      setError(t('adminlogin.failed'));
    }
    setBusy(false);
  }

  return (
    <>
      {/* Also offered with a code from a link: it may have expired or been used already. */}
      <p>
        <button type="button" className={initialCode ? 'secondary' : undefined} onClick={requestCode} disabled={busy}>
          {t('adminlogin.request')}
        </button>
      </p>
      {notice && <p className="muted">{notice}</p>}
      <form onSubmit={signIn}>
        <label>
          {t('adminlogin.code')}
          <input
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            required
          />
        </label>
        <button type="submit" disabled={busy || !code.trim()}>{t('adminlogin.submit')}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </>
  );
}
