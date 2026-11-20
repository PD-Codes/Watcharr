'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';
import './quickconnect.css';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'pending'; code: string; expiresAt: number; webUrl: string | null }
  | { kind: 'finishing' }
  | { kind: 'expired' }
  | { kind: 'disabled' }
  | { kind: 'failed'; message: string };

const POLL_MS = 2000;

/** "9:05" — the countdown is a number like any other, so it is set in the mono face. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Jellyfin Quick Connect: show a code, the person approves it in a Jellyfin client where they are
 * already signed in, and this page polls until the server confirms. The secret that redeems the
 * approval never reaches the browser; the server holds it, bound to this browser by a cookie.
 */
export default function QuickConnectLogin({ serverId, setupToken }: { serverId: number; setupToken?: string }) {
  const t = useT();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onVisible = useRef<(() => void) | null>(null);
  // The poller reads the token at tick time, so editing the field mid-flow is not lost.
  const token = useRef(setupToken);
  token.current = setupToken;

  function stop() {
    if (timer.current) clearInterval(timer.current);
    if (clockTimer.current) clearInterval(clockTimer.current);
    timer.current = null;
    clockTimer.current = null;
    if (onVisible.current) document.removeEventListener('visibilitychange', onVisible.current);
    onVisible.current = null;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount cleanup only; stop() works on refs, so the first one is as good as any
  useEffect(() => stop, []);

  function end(next: Phase) {
    stop();
    setPhase(next);
  }

  async function start() {
    stop(); // a second start must not leave the first poller running unreachable
    setCopied(false);
    setPhase({ kind: 'starting' });
    let data: { code?: string; expiresAt?: number; webUrl?: string | null };
    let res: Response;
    try {
      res = await fetch('/api/auth/quickconnect/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId }),
      });
      data = await res.json().catch(() => ({}));
    } catch {
      return end({ kind: 'failed', message: t('acc2.qc.failed') });
    }
    if (res.status === 409) return end({ kind: 'disabled' });
    if (!res.ok || !data.code || !data.expiresAt) return end({ kind: 'failed', message: t('acc2.qc.failed') });

    const pending: Phase = { kind: 'pending', code: data.code, expiresAt: data.expiresAt, webUrl: data.webUrl ?? null };
    setPhase(pending);
    setNow(Date.now());
    clockTimer.current = setInterval(() => {
      setNow(Date.now());
      if (Date.now() > pending.expiresAt) end({ kind: 'expired' });
    }, 1000);

    let inFlight = false;
    const tick = async () => {
      if (inFlight) return; // a slow answer must not stack requests behind itself
      inFlight = true;
      try {
        const poll = await fetch('/api/auth/quickconnect/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupToken: token.current || undefined }),
        });
        const result = (await poll.json().catch(() => ({}))) as { ok?: boolean; code?: string };
        if (result.ok) {
          end({ kind: 'finishing' });
          router.push('/watchlist');
        } else if (poll.status === 401 || (poll.status === 429 && result.code === 'setup-token')) {
          end({ kind: 'failed', message: t('login.setupTokenInvalid') }); // retrying cannot help
        } else if (poll.status === 410) {
          end({ kind: 'expired' });
        } else if (poll.status === 400) {
          end({ kind: 'failed', message: result.code === 'unbound' ? t('acc2.qc.otherBrowser') : t('acc2.qc.failed') });
        }
        // Pending, a throttled poll, 5xx or a dropped connection: asked again on the next tick.
      } catch {
        // Network error: same as above.
      } finally {
        inFlight = false;
      }
    };
    timer.current = setInterval(tick, POLL_MS);
    // A phone freezes this tab while the Jellyfin app is in front; ask right away on return.
    onVisible.current = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible.current);
  }

  async function cancel() {
    end({ kind: 'idle' });
    await fetch('/api/auth/quickconnect', { method: 'DELETE' }).catch(() => {});
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (plain http outside localhost): the code is on screen to read off.
    }
  }

  if (phase.kind === 'pending') {
    const left = phase.expiresAt - now;
    return (
      <div className="qc-panel" aria-live="polite">
        <p className="muted qc-intro">{t('acc2.qc.intro')}</p>
        {/* Approving a code signs in whoever requested it. Somebody else's code, sent with a
            convincing message, would sign them in as you: hence the warning next to the code. */}
        <p className="muted qc-intro">
          <strong>{t('fix2.qc.ownCodeOnly')}</strong>
        </p>
        {/* A label as text, not aria-label: on a plain paragraph screen readers ignore aria-label. */}
        <p className="qc-code">
          <span className="sr-only">{t('acc2.qc.codeLabel')}: </span>
          {phase.code}
        </p>
        <p className="qc-status muted">
          <span className="qc-wait" aria-hidden />
          {t('acc2.qc.waiting')} · {t('acc2.qc.expiresIn')} <span className="qc-clock">{clock(left)}</span>
        </p>
        <div className="qc-actions">
          <button type="button" className="tonal" onClick={() => copy(phase.code)}>
            {copied ? t('acc2.qc.copied') : t('acc2.qc.copy')}
          </button>
          {phase.webUrl && (
            <a className="button outlined" href={phase.webUrl} target="_blank" rel="noopener noreferrer">
              {t('acc2.qc.openJellyfin')}
            </a>
          )}
          <button type="button" className="link" onClick={cancel}>
            {t('acc2.qc.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="qc-panel">
      {phase.kind === 'finishing' ? (
        <p className="muted">{t('acc2.qc.finishing')}</p>
      ) : phase.kind === 'expired' ? (
        <>
          <p className="muted">{t('acc2.qc.expired')}</p>
          <button type="button" className="outlined" onClick={start}>
            {t('acc2.qc.restart')}
          </button>
        </>
      ) : phase.kind === 'disabled' ? (
        <p className="muted">{t('acc2.qc.disabled')}</p>
      ) : (
        <button type="button" className="outlined" onClick={start} disabled={phase.kind === 'starting'}>
          {phase.kind === 'starting' ? t('acc2.qc.starting') : t('acc2.qc.button')}
        </button>
      )}
      {phase.kind === 'failed' && <p className="error">{phase.message}</p>}
    </div>
  );
}
