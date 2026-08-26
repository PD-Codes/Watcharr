'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

type Pin = { pinId: string; code: string; authUrl: string };

/** Plex PIN OAuth: open plex.tv, approve the code, poll until a token comes back. */
export default function PlexLogin({ serverId }: { serverId: number }) {
  const t = useT();
  const router = useRouter();
  const [pin, setPin] = useState<Pin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  async function start() {
    setError(null);
    const res = await fetch('/api/auth/plex/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId }),
    });
    if (!res.ok) return setError(t('login.plexFailed'));
    const next = (await res.json()) as Pin;
    setPin(next);
    window.open(next.authUrl, '_blank', 'noopener');

    timer.current = setInterval(async () => {
      const poll = await fetch('/api/auth/plex/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinId: next.pinId, serverId }),
      });
      const data = (await poll.json()) as { ok?: boolean; pending?: boolean };
      if (data.ok) {
        if (timer.current) clearInterval(timer.current);
        router.push('/watchlist');
      }
    }, 2000);
  }

  return (
    <div>
      {!pin ? (
        <button onClick={start}>{t('login.plexButton')}</button>
      ) : (
        <p className="muted">
          {t('login.plexHint')}
          <br />
          <a href={pin.authUrl} target="_blank" rel="noopener noreferrer">
            {pin.authUrl}
          </a>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
