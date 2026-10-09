'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

export default function DeleteBadgeButton({ id, name }: { id: number; name: string }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!window.confirm(t('badges.confirmDelete', { name }))) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/badges', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="outlined danger" onClick={remove} disabled={busy}>
      {t('users.delete')}
    </button>
  );
}
