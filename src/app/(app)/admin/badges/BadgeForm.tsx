'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';
import type { TranslationKey } from '@/i18n';

const EMPTY = {
  name: '',
  description: '',
  icon: '\u{1F3C5}',
  metric: 'plays',
  filter: 'none',
  filterValue: '',
  tiers: '1, 10, 50',
};

/**
 * Defines one custom badge, or edits it when `id` is given. The route validates again;
 * this only keeps the form honest.
 */
export default function BadgeForm({ id, initial }: { id?: number; initial?: typeof EMPTY }) {
  const t = useT();
  const router = useRouter();
  const [form, setForm] = useState(initial ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof EMPTY) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/badges', {
        method: id === undefined ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id === undefined ? form : { ...form, id }),
      });
      if (res.ok) {
        if (id === undefined) {
          setForm(EMPTY);
          router.refresh();
        } else {
          router.push('/admin/badges');
        }
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? t('badges.failed'));
      }
    } catch {
      setError(t('badges.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card section">
      <h2>{id === undefined ? t('badges.new') : t('badges.editing')}</h2>
      <label>
        {t('badges.name')}
        <input value={form.name} onChange={set('name')} maxLength={40} required />
      </label>
      <label>
        {t('badges.description')}
        <input value={form.description} onChange={set('description')} maxLength={120} />
      </label>
      <label style={{ display: 'grid' }}>
        {t('badges.icon')}
        <input value={form.icon} onChange={set('icon')} maxLength={8} style={{ maxWidth: 120 }} />
      </label>
      <label>
        {t('badges.metric')}
        <select value={form.metric} onChange={set('metric')}>
          {['plays', 'hours', 'days', 'titles', 'shows'].map((metric) => (
            <option key={metric} value={metric}>
              {t(`badges.metric.${metric}` as TranslationKey)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('badges.filter')}
        <select value={form.filter} onChange={set('filter')}>
          {['none', 'genre', 'text'].map((filter) => (
            <option key={filter} value={filter}>
              {t(`badges.filter.${filter}` as TranslationKey)}
            </option>
          ))}
        </select>
      </label>
      {form.filter !== 'none' && (
        <label>
          {t('badges.filterValue')}
          <input value={form.filterValue} onChange={set('filterValue')} maxLength={60} required />
        </label>
      )}
      <label>
        {t('badges.tiers')}
        <input value={form.tiers} onChange={set('tiers')} required />
        <span className="muted">{t('badges.tiersHint')}</span>
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" disabled={busy}>
          {id === undefined ? t('badges.create') : t('badges.save')}
        </button>
        {id !== undefined && (
          <Link href="/admin/badges" className="button outlined">
            {t('badges.cancel')}
          </Link>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
