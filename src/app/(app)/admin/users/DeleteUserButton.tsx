'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

/**
 * Deletes a person with all their data. The route checks who may do this again; the
 * confirmation names the person and says what goes, because there is no way back
 * apart from a backup.
 */
export default function DeleteUserButton({
  userId,
  username,
  plays,
  redirectTo,
}: {
  userId: number;
  username: string;
  plays: number;
  /** Where to go afterwards (the detail page has nothing left to show); the list just refreshes. */
  redirectTo?: string;
}) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm(t('users.confirmDelete', { username, count: plays }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        if (redirectTo) router.push(redirectTo);
        router.refresh();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? t('users.deleteFailed'));
      }
    } catch {
      setError(t('users.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="outlined danger" onClick={remove} disabled={busy}>
        {t('users.delete')}
      </button>
      {error && (
        <p className="muted" role="alert" style={{ margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </>
  );
}
