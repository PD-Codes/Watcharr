'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

/** The subscribe/unsubscribe control. Always the user's own — there is no id to pass. */
export default function NewsletterSubscription({
  subscribedEmail,
  suggestedEmail,
  scheduleHint,
}: {
  subscribedEmail: string | null;
  /** The media server's address, offered as the default rather than forced. */
  suggestedEmail: string;
  scheduleHint: string;
}) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(method: 'POST' | 'DELETE', email?: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await fetch('/api/newsletter', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ email }) : undefined,
    });
    setBusy(false);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || body.error) {
      setError(body.error ?? t('error.generic'));
      return;
    }
    setMessage(method === 'POST' ? t('profile.nlSubscribed') : t('profile.nlUnsubscribed'));
    router.refresh();
  }

  return (
    <form
      className="card"
      style={{ maxWidth: 520 }}
      onSubmit={(event) => {
        event.preventDefault();
        void call('POST', String(new FormData(event.currentTarget).get('email') ?? ''));
      }}
    >
      <p className="stat-label">{t('profile.nlHeading')}</p>
      <p className="muted" style={{ marginTop: 0 }}>
        {scheduleHint}
      </p>

      <label>
        {t('profile.nlEmail')}
        <input
          name="email"
          type="email"
          defaultValue={subscribedEmail ?? suggestedEmail}
          placeholder="you@example.com"
          required
        />
      </label>

      <div className="row" style={{ gap: 10, marginTop: 12 }}>
        <button disabled={busy}>
          {subscribedEmail ? t('profile.nlUpdate') : t('profile.nlSubscribe')}
        </button>
        {subscribedEmail && (
          <button
            type="button"
            className="outlined"
            disabled={busy}
            onClick={() => void call('DELETE')}
          >
            {t('profile.nlUnsubscribe')}
          </button>
        )}
      </div>

      {subscribedEmail && (
        <p className="muted" style={{ marginTop: 12 }}>
          {t('profile.nlDeliveredTo', { email: subscribedEmail })}
        </p>
      )}
      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
