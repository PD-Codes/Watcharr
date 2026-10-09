'use client';

import { useState } from 'react';
import { useT } from '@/i18n/client';

/** Starts the preview of `userId` (admin lists) or, without one, ends it (the banner). */
export default function ViewAsButton({ userId, label }: { userId?: number; label?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const leaving = userId === undefined;

  return (
    <button
      type="button"
      className={leaving ? 'outlined' : 'tonal'}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch('/api/admin/view-as', {
            method: leaving ? 'DELETE' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: leaving ? undefined : JSON.stringify({ userId }),
          });
          if (!res.ok) return;
          // A full navigation: every server component has to render again as the other person.
          window.location.assign(leaving ? '/admin/users' : '/');
        } finally {
          setBusy(false);
        }
      }}
    >
      {label ?? (leaving ? t('viewAs.exit') : t('viewAs.start'))}
    </button>
  );
}
