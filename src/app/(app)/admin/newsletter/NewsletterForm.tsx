'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LOCALES, LOCALE_NAMES, type TranslationKey } from '@/i18n';
import { useT } from '@/i18n/client';

// Indexed by getDay(), so the order is the JavaScript one and not a display choice.
const DAY_KEYS: TranslationKey[] = [
  'weekday.sunday',
  'weekday.monday',
  'weekday.tuesday',
  'weekday.wednesday',
  'weekday.thursday',
  'weekday.friday',
  'weekday.saturday',
];

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
  adminEmail,
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
  /** Default recipient of the test mail. */
  adminEmail: string | null;
}) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<{ html: string; items: number; locales: Record<string, number> } | null>(null);
  const [previewLocale, setPreviewLocale] = useState<string>('');

  // The unsaved values of the form: the preview shows what Save would send, not what is stored.
  function draft(form: HTMLFormElement) {
    const data = new FormData(form);
    return {
      days: Number(data.get('days')),
      libraries: libraries.filter((l) => data.get(`library.${l.id}`) === 'on').map((l) => l.id),
      subject: String(data.get('subject') ?? ''),
      intro: String(data.get('intro') ?? ''),
      locale: previewLocale || undefined,
    };
  }

  async function post(url: string, payload: unknown) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    return { ok: res.ok && !body.error, body };
  }

  async function showPreview(form: HTMLFormElement, locale = previewLocale) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { ok, body } = await post('/api/admin/newsletter/preview', { ...draft(form), locale: locale || undefined });
      if (!ok) setError(body.error ?? t('adminNewsletter.previewFailed'));
      else setPreview(body as unknown as NonNullable<typeof preview>);
    } catch {
      setError(t('adminNewsletter.previewFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    const to = window.prompt(t('adminNewsletter.testPrompt'), adminEmail ?? '');
    if (!to) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { ok, body } = await post('/api/admin/newsletter/test', { email: to, locale: previewLocale || undefined });
      if (ok) setMessage(t('adminNewsletter.testSent', { email: to }));
      else setError(body.error ?? t('adminNewsletter.saveFailed'));
    } catch {
      setError(t('adminNewsletter.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  // The path is spliced into the translated sentence so the hint stays one key.
  const [hintBefore, hintAfter = ''] = t('adminNewsletter.uniqueIdHint').split('{path}');

  async function submit(form: HTMLFormElement, sendNow: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);

    const data = new FormData(form);
    try {
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
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        sent?: number;
        error?: string;
      };
      if (!res.ok || body.error) {
        setError(body.error ?? t('adminNewsletter.saveFailed'));
        return;
      }
      setMessage(
        sendNow
          ? t('adminNewsletter.sent', { count: body.sent ?? 0 })
          : t('action.saved'),
      );
      router.refresh();
    } catch {
      setError(t('adminNewsletter.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget, false); }} style={{ maxWidth: 620 }}>
      <label className="row">
        <input type="checkbox" name="enabled" defaultChecked={enabled} />
        {t('adminNewsletter.scheduleEnabled')}
      </label>

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('adminNewsletter.schedule')}
      </p>
      <label>
        {t('adminNewsletter.everyWeekOn')}
        <select name="dayOfWeek" defaultValue={String(dayOfWeek)}>
          {DAY_KEYS.map((dayKey, index) => (
            <option key={dayKey} value={index}>
              {t(dayKey)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('adminNewsletter.atHour')}
        <select name="hour" defaultValue={String(hour)}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}:00
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('adminNewsletter.timeFrame')}
        <input name="days" type="number" min={1} max={90} defaultValue={days} required />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        {t('adminNewsletter.timeFrameHint')}
      </p>

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('adminNewsletter.libraries')}
      </p>
      {libraries.length === 0 ? (
        <p className="muted">{t('adminNewsletter.noLibraries')}</p>
      ) : (
        libraries.map((library) => (
          <label className="row" key={library.id}>
            <input
              type="checkbox"
              name={`library.${library.id}`}
              defaultChecked={selectedLibraries.length === 0 || selectedLibraries.includes(library.id)}
            />
            {library.name}
          </label>
        ))
      )}

      <p className="stat-label" style={{ marginTop: 20 }}>
        {t('adminNewsletter.content')}
      </p>
      <label>
        {t('adminNewsletter.subject')}
        <input name="subject" defaultValue={subject} required />
      </label>
      <label>
        {t('adminNewsletter.intro')}
        <textarea
          name="intro"
          rows={3}
          defaultValue={intro}
          placeholder={t('adminNewsletter.introPlaceholder')}
        />
      </label>
      <label>
        {t('adminNewsletter.uniqueId')}
        <input name="uniqueId" defaultValue={uniqueId} />
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        {hintBefore}
        <code>/newsletter/{uniqueId}</code>
        {hintAfter}
      </p>

      <div className="row" style={{ gap: 10, marginTop: 16 }}>
        <button disabled={busy}>{t('action.save')}</button>
        <button
          type="button"
          className="outlined"
          disabled={busy}
          onClick={(e) => void submit(e.currentTarget.form!, true)}
        >
          {t('adminNewsletter.saveAndSend')}
        </button>
        <button
          type="button"
          className="tonal"
          disabled={busy}
          onClick={(e) => void showPreview(e.currentTarget.form!)}
        >
          {t('adminNewsletter.preview')}
        </button>
        {hasEmailChannel && (
          <button
            type="button"
            className="outlined"
            disabled={busy}
            onClick={() => void sendTest()}
          >
            {t('adminNewsletter.sendTest')}
          </button>
        )}
      </div>

      {preview && (
        <div style={{ marginTop: 20 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <p className="stat-label" style={{ margin: 0 }}>
              {t('adminNewsletter.previewTitle', { count: preview.items })}
            </p>
            <select
              aria-label={t('adminNewsletter.previewLanguage')}
              value={previewLocale || Object.keys(preview.locales)[0] || ''}
              onChange={(e) => {
                setPreviewLocale(e.target.value);
                void showPreview(e.currentTarget.form!, e.target.value);
              }}
            >
              {LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {LOCALE_NAMES[locale]}
                  {preview.locales[locale] ? ` · ${t('adminNewsletter.previewSubscribers', { count: preview.locales[locale] })}` : ''}
                </option>
              ))}
            </select>
          </div>
          {/* Empty sandbox: no scripts, no forms, no same-origin — titles come from a media server. */}
          <iframe
            title={t('adminNewsletter.previewTitle', { count: preview.items })}
            sandbox=""
            srcDoc={preview.html}
            style={{ width: '100%', height: 560, marginTop: 10, border: '1px solid var(--line-strong)', borderRadius: 8, background: '#131211' }}
          />
        </div>
      )}

      <p className="muted" style={{ marginTop: 12 }}>
        {t('adminNewsletter.subscriberCount', { count: subscriberCount })}
        {!hasEmailChannel && ` ${t('adminNewsletter.needsEmailChannel')}`}
      </p>
      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
