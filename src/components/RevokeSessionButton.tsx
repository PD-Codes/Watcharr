'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

/** Signs one session out remotely. Same confirm-then-fetch shape as TerminateButton. */
export default function RevokeSessionButton({ id }: { id: string }) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!window.confirm(t('session.revokeConfirm'))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? t('session.revokeFailed'));
      }
    } catch {
      setError(t('error.unreachable'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="outlined" onClick={revoke} disabled={busy}>
        {busy ? t('session.signingOut') : t('action.signOut')}
      </button>
      {error && (
        <p className="muted" role="alert" style={{ margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </>
  );
}
