'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface LibraryOption {
  id: string;
  name: string;
}

export default function NewsletterForm({
  enabled,
  dayOfWeek,
  hour,
  days,
  libraries,
  selectedLibraries,
  subject,
  intro,
  uniqueId,
  subscriberCount,
  hasEmailChannel,
}: {
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  days: number;
  libraries: LibraryOption[];
  selectedLibraries: string[];
  subject: string;
  intro: string;
  uniqueId: string;
  subscriberCount: number;
  /** Without an email channel there is no SMTP transport, so sending cannot work. */
  hasEmailChannel: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(form: HTMLFormElement, sendNow: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);

    const data = new FormData(form);
    const res = await fetch('/api/admin/newsletter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: data.get('enabled') === 'on',
        dayOfWeek: Number(data.get('dayOfWeek')),
        hour: Number(data.get('hour')),
        days: Number(data.get('days')),
        libraries: libraries.filter((l) => data.get(`library.${l.id}`) === 'on').map((l) => l.id),
        subject: String(data.get('subject') ?? ''),
        intro: String(data.get('intro') ?? ''),
        uniqueId: String(data.get('uniqueId') ?? ''),
        sendNow,
      }),
    });
    setBusy(false);

    const body = (await res.json()) as { ok?: boolean; sent?: number; error?: string };
    if (!res.ok || body.error) {
      setError(body.error ?? 'Could not save');
      return;
    }
    setMessage(sendNow ? `Sent to ${body.sent ?? 0} subscriber(s).` : 'Saved.');
    router.refresh();
  }

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget, false); }} style={{ maxWidth: 620 }}>
      <label className="row">
        <input type="checkbox" name="enabled" defaultChecked={enabled} style={{ width: 'auto' }} />
        Send the newsletter on a schedule
      </label>

      <p className="stat-label" style={{ marginTop: 20 }}>
        Schedule
      </p>
      <label>
        Every week on
        <select name="dayOfWeek" defaultValue={String(dayOfWeek)}>
          {DAYS.map((day, index) => (
            <option key={day} value={index}>
              {day}
            </option>
          ))}
        </select>
      </label>
      <label>
        at (hour)
        <select name="hour" defaultValue={String(hour)}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}:00
            </option>
          ))}
        </select>
      </label>
      <label>
        Time frame (days)
        <input name="days" type="number" min={1} max={90} defaultValue={days} required />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        How far back the issue reaches. Checked on the normal activity poll, so the server
        has to be running at that hour.
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        Included libraries
      </p>
      {libraries.length === 0 ? (
        <p className="muted">The media server did not report any libraries.</p>
      ) : (
        libraries.map((library) => (
          <label className="row" key={library.id}>
            <input
              type="checkbox"
              name={`library.${library.id}`}
              defaultChecked={selectedLibraries.length === 0 || selectedLibraries.includes(library.id)}
              style={{ width: 'auto' }}
            />
            {library.name}
          </label>
        ))
      )}

      <p className="stat-label" style={{ marginTop: 20 }}>
        Content
      </p>
      <label>
        Subject
        <input name="subject" defaultValue={subject} required />
      </label>
      <label>
        Intro text
        <textarea name="intro" rows={3} defaultValue={intro} placeholder="Optional, shown above the posters" />
      </label>
      <label>
        Unique ID name
        <input name="uniqueId" defaultValue={uniqueId} />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        The last sent issue stays available at <code>/newsletter/{uniqueId}</code> for anyone
        signed in. Letters, numbers, underscores and hyphens only.
      </p>

      <div className="row" style={{ gap: 10, marginTop: 16 }}>
        <button disabled={busy}>Save</button>
        <button
          type="button"
          className="outlined"
          disabled={busy}
          onClick={(e) => void submit(e.currentTarget.form!, true)}
        >
          Save and send now
        </button>
      </div>

      <p className="muted" style={{ marginTop: 12 }}>
        {subscriberCount} subscriber{subscriberCount === 1 ? '' : 's'}. People subscribe
        themselves on their profile page — an admin cannot sign anyone up.
        {!hasEmailChannel && ' Sending needs an email channel under Notifications.'}
      </p>
      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
