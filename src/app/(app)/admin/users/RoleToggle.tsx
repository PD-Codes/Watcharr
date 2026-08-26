'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

/**
 * Grants or revokes the deployment-wide admin role. Only rendered for a global admin; the
 * route behind it checks the same thing again, and refuses to remove the last one.
 */
export default function RoleToggle({
  userId,
  username,
  globalAdmin,
  self,
}: {
  userId: number;
  username: string;
  globalAdmin: boolean;
  /** Demoting yourself is allowed, but worth a confirmation — it is not undoable alone. */
  self: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (globalAdmin && self && !window.confirm(t('users.confirmDemoteSelf'))) return;
    if (!globalAdmin && !window.confirm(t('users.confirmPromote', { username }))) return;

    setBusy(true);
    setError(null);
    const res = await fetch('/api/admin/users/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, globalAdmin: !globalAdmin }),
    });
    setBusy(false);
    if (res.ok) router.refresh();
    else setError(((await res.json()) as { error?: string }).error ?? t('users.roleFailed'));
  }

  return (
    <>
      <button type="button" className="outlined" onClick={toggle} disabled={busy}>
        {globalAdmin ? t('users.revokeGlobal') : t('users.makeGlobal')}
      </button>
      {error && (
        <p className="muted" role="alert" style={{ margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </>
  );
}
