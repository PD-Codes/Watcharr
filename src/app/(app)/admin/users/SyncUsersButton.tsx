'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SyncUsersButton() {
  const router = useRouter();
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
      {busy ? 'Importing…' : 'Import users from media server'}
    </button>
  );
}
