'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

type Pin = { pinId: string; code: string; authUrl: string };

const POLL_MS = 2000;
// plex.tv lets a PIN expire after about fifteen minutes; polling past that can never succeed.
const POLL_DEADLINE_MS = 15 * 60_000;

/** Plex PIN OAuth: open plex.tv, approve the code, poll until a token comes back. */
export default function PlexLogin({ serverId, askSetupToken }: { serverId: number; askSetupToken?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [pin, setPin] = useState<Pin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [setupToken, setSetupToken] = useState('');

  const onVisible = useRef<(() => void) | null>(null);

  function stop() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (onVisible.current) document.removeEventListener('visibilitychange', onVisible.current);
    onVisible.current = null;
  }

  useEffect(() => stop, []);

  // Ends the flow with a message and brings the button back, so the user can start over.
  function giveUp(message: string) {
    stop();
    setPin(null);
    setError(message);
  }

  async function start() {
    stop(); // a second click must not leave the first poller running unreachable
    setError(null);
    // Opened inside the click: browsers (iOS above all) block a window opened after an await.
    const popup = window.open('', '_blank');
    if (popup) popup.opener = null;
    try {
      const res = await fetch('/api/auth/plex/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId }),
      });
      if (!res.ok) {
        popup?.close();
        return setError(t('login.plexFailed'));
      }
      const next = (await res.json()) as Pin;
      setPin(next);
      if (popup) popup.location.href = next.authUrl;
      else window.open(next.authUrl, '_blank', 'noopener');

      const deadline = Date.now() + POLL_DEADLINE_MS;
      let inFlight = false;
      const tick = async () => {
        if (inFlight) return; // a slow answer must not stack requests behind itself
        if (Date.now() > deadline) return giveUp(t('login.plexExpired'));
        inFlight = true;
        try {
          const poll = await fetch('/api/auth/plex/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinId: next.pinId, serverId, setupToken: setupToken || undefined }),
          });
          const data = (await poll.json().catch(() => ({}))) as { ok?: boolean };
          if (data.ok) {
            stop();
            router.push('/watchlist');
          } else if (poll.status === 401 || poll.status === 429) {
            giveUp(t('login.setupTokenInvalid')); // a wrong or throttled setup token: retrying cannot help
          } else if (poll.status === 403) {
            giveUp(t('login.plexNoAccess')); // approved, but by an account this server does not list
          } else if (poll.status === 400) {
            giveUp(t('login.plexFailed')); // the request itself is wrong; asking again changes nothing
          }
          // Anything else (pending, 429, 5xx, a dropped connection) is retried on the next tick.
        } catch {
          // Network error: same as above.
        } finally {
          inFlight = false;
        }
      };
      timer.current = setInterval(tick, POLL_MS);
      // A phone freezes this tab while plex.tv is in front; ask right away when it returns.
      onVisible.current = () => {
        if (document.visibilityState === 'visible') void tick();
      };
      document.addEventListener('visibilitychange', onVisible.current);
    } catch {
      popup?.close();
      setError(t('login.plexFailed'));
    }
  }

  return (
    <div>
      {!pin && askSetupToken && (
        <label>
          {t('login.setupToken')}
          <input
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX"
          />
          <span className="muted">{t('login.setupTokenHint')}</span>
        </label>
      )}
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
