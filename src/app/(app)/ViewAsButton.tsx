'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

/** Starts the preview of `userId` (admin lists) or, without one, ends it (the banner). */
export default function ViewAsButton({ userId, label }: { userId?: number; label?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = userId === undefined;

  // Coming back through the browser's back button restores this page as it was left, busy
  // included; without this the button would stay greyed out for good.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  return (
    <>
      <button
        type="button"
        className={leaving ? 'outlined' : 'tonal'}
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          try {
            const res = await fetch('/api/admin/view-as', {
              method: leaving ? 'DELETE' : 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: leaving ? undefined : JSON.stringify({ userId }),
            });
            if (!res.ok) throw new Error(String(res.status));
            // A full navigation: every server component has to render again as the other person.
            // The button stays busy until the new page replaces this one — the overview can take
            // seconds on a big database, and a button that looks idle then reads as "nothing happened".
            window.location.assign(leaving ? '/admin/users' : '/');
          } catch {
            setFailed(true);
            setBusy(false);
          }
        }}
      >
        {busy ? t('viewAs.opening') : (label ?? (leaving ? t('viewAs.exit') : t('viewAs.start')))}
      </button>
      {failed && (
        <p className="muted" role="alert" style={{ margin: '6px 0 0' }}>
          {t('viewAs.failed')}
        </p>
      )}
    </>
  );
}
