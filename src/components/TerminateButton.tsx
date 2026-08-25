'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Stops one running stream. The confirmation doubles as the message box: whatever is
 * typed is shown to the viewer, an empty entry stops the stream without a message.
 */
export default function TerminateButton({ sessionKey }: { sessionKey: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    const reason = window.prompt('Stop this stream? Optional message for the viewer:', '');
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
        setError(body?.error ?? 'Could not stop the stream');
      }
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="outlined" onClick={stop} disabled={busy}>
        {busy ? 'Stopping…' : 'Stop'}
      </button>
      {error && (
        <p className="muted" role="alert" style={{ margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </>
  );
}
