'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

export default function SyncUsersButton() {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch('/api/admin/users/sync', { method: 'POST' });
        setBusy(false);
        router.refresh();
      }}
    >
      {busy ? t('users.importing') : t('users.import')}
    </button>
  );
}
