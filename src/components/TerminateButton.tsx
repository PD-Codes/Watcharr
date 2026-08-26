'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

/**
 * Stops one running stream. The confirmation doubles as the message box: whatever is
 * typed is shown to the viewer, an empty entry stops the stream without a message.
 */
export default function TerminateButton({ sessionKey }: { sessionKey: string }) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    const reason = window.prompt(t('terminate.prompt'), '');
    if (reason === null) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/sessions/terminate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey, reason }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? t('terminate.failed'));
      }
    } catch {
      setError(t('error.unreachable'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="outlined" onClick={stop} disabled={busy}>
        {busy ? t('terminate.stopping') : t('terminate.stop')}
      </button>
      {error && (
        <p className="muted" role="alert" style={{ margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </>
  );
}
