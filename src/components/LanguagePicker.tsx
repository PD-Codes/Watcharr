'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LOCALES, LOCALE_NAMES } from '@/i18n';
import { useT } from '@/i18n/client';

/**
 * The user's own language. Saved to the database rather than a cookie, so the choice
 * follows the account instead of the browser — router.refresh() then re-renders every
 * server component with the new locale, without a full page load.
 */
export default function LanguagePicker({ current }: { current: string | null }) {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string) {
    setValue(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/profile/locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: next || null }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        setError(t('profile.language.failed'));
      }
    } catch {
      setError(t('error.unreachable'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="filters">
      <label>
        {t('profile.language.label')}
        <select value={value} disabled={busy} onChange={(event) => save(event.target.value)}>
          <option value="">{t('profile.language.followDefault')}</option>
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="muted" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
