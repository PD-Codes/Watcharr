'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (globalAdmin && self && !window.confirm('Give up your own global admin rights?')) return;
    if (!globalAdmin && !window.confirm(`Make ${username} a global admin of every server?`)) return;

    setBusy(true);
    setError(null);
    const res = await fetch('/api/admin/users/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, globalAdmin: !globalAdmin }),
    });
    setBusy(false);
    if (res.ok) router.refresh();
    else setError(((await res.json()) as { error?: string }).error ?? 'Could not change the role');
  }

  return (
    <>
      <button type="button" className="outlined" onClick={toggle} disabled={busy}>
        {globalAdmin ? 'Revoke global' : 'Make global'}
      </button>
      {error && (
        <p className="muted" role="alert" style={{ margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </>
  );
}
