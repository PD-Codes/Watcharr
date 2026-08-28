'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { NOTIFICATION_EVENTS } from '@/server/features';
import { useT } from '@/i18n/client';

/**
 * Personal event mails. Always the signed-in user's own — like the newsletter form next to
 * it, there is no user id to pass; the route reads it from the session.
 */
export default function EventPrefs({
  email,
  suggestedEmail,
  events,
  selectable,
  mailConfigured,
}: {
  email: string | null;
  suggestedEmail: string;
  events: string[];
  /** Events this user is allowed to pick; a non-admin gets fewer. */
  selectable: string[];
  mailConfigured: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labels = new Map(NOTIFICATION_EVENTS.map((e) => [e.key as string, e.labelKey]));

  async function save(body: { email: string | null; events: string[] }) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    const result = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || result.error) {
      setError(result.error ?? t('error.generic'));
      return;
    }
    setMessage(t('notifyMe.saved'));
    router.refresh();
  }

  return (
    <form
      className="card"
      style={{ maxWidth: 520 }}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void save({
          email: String(form.get('email') ?? '').trim() || null,
          events: selectable.filter((key) => form.get(`event.${key}`) === 'on'),
        });
      }}
    >
      <p className="stat-label">{t('notifyMe.eventsHeading')}</p>
      <p className="muted" style={{ marginTop: 0 }}>
        {mailConfigured ? t('notifyMe.eventsHint') : t('notifyMe.noMailChannel')}
      </p>

      <label>
        {t('profile.nlEmail')}
        <input
          name="email"
          type="email"
          defaultValue={email ?? suggestedEmail}
          placeholder="you@example.com"
        />
      </label>

      <div style={{ marginTop: 12 }}>
        {selectable.map((key) => (
          <label className="row" key={key}>
            <input
              type="checkbox"
              name={`event.${key}`}
              defaultChecked={events.includes(key)}
              style={{ width: 'auto' }}
            />
            {t(labels.get(key) ?? 'error.generic')}
          </label>
        ))}
      </div>

      <div className="row" style={{ gap: 10, marginTop: 12 }}>
        <button disabled={busy}>{t('action.save')}</button>
        {(email || events.length > 0) && (
          <button
            type="button"
            className="outlined"
            disabled={busy}
            onClick={() => void save({ email: null, events: [] })}
          >
            {t('notifyMe.turnOff')}
          </button>
        )}
      </div>

      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
