'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

const TRIES = 30;
const POLL_MS = 1500;

/**
 * Finishes the Plex login in the tab plex.tv just returned to. The tab that started the flow
 * may be asleep (phones freeze background tabs), so this one polls the same PIN itself.
 */
export default function PlexDone({ pinId, serverId }: { pinId: string; serverId: number }) {
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(pinId ? null : t('login.plexFailed'));

  useEffect(() => {
    if (!pinId) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < TRIES && !cancelled; i++) {
        try {
          const res = await fetch('/api/auth/plex/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinId, serverId: serverId || undefined }),
          });
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
          if (data.ok) return router.replace('/watchlist');
          if (res.status === 403) return setError(t('login.plexNoAccess'));
          if (res.status === 401 || res.status === 400) return setError(t('login.plexFailed'));
        } catch {
          // A dropped connection is retried like a pending PIN.
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (!cancelled) setError(t('login.plexExpired'));
    })();
    return () => {
      cancelled = true;
    };
  }, [pinId, serverId, router, t]);

  return error ? (
    <>
      <p className="error">{error}</p>
      <Link href="/login">{t('login.backToLogin')}</Link>
    </>
  ) : (
    <p className="muted">{t('login.plexFinishing')}</p>
  );
}
