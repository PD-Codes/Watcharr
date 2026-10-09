'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

interface Stats {
  tmdb: { entries: number; found: number; misses: number; expired: number; oldest: number | null };
  coverage: { cached: number; total: number } | null;
  library: { serverId: number; label: string; items: number; sections: number; ageMs: number }[];
  geoip: { entries: number; oldest: number | null };
  suggestions: { entries: number; expired: number };
  job: { running: boolean; looked: number | null; error: string | null };
}

const age = (ms: number) =>
  ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`;
const since = (at: number | null) => (at ? new Date(at).toLocaleDateString() : '—');

export default function CachesManager({ initial, tmdbConfigured }: { initial: Stats; tmdbConfigured: boolean }) {
  const t = useT();
  const [stats, setStats] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // A refresh runs in the background; poll until it says it is done.
  useEffect(() => {
    if (!stats.job.running) return;
    const timer = setInterval(async () => {
      const res = await fetch('/api/admin/caches').catch(() => null);
      if (res?.ok) setStats((await res.json()) as Stats);
    }, 2000);
    return () => clearInterval(timer);
  }, [stats.job.running]);

  async function act(action: string, confirmKey?: 'caches.confirmClear') {
    if (confirmKey && !window.confirm(t(confirmKey))) return;
    setBusy(action);
    setNote(null);
    try {
      const res = await fetch('/api/admin/caches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => ({}))) as { stats?: Stats; removed?: number; error?: string };
      if (body.stats) setStats(body.stats);
      setNote(body.error ?? (body.removed ? t('caches.removed', { count: body.removed }) : null));
    } finally {
      setBusy(null);
    }
  }

  const button = (action: string, label: string, opts: { outlined?: boolean; confirm?: boolean; disabled?: boolean } = {}) => (
    <button
      type="button"
      className={opts.outlined ? 'outlined' : undefined}
      disabled={busy !== null || opts.disabled}
      onClick={() => void act(action, opts.confirm ? 'caches.confirmClear' : undefined)}
    >
      {label}
    </button>
  );

  return (
    <>
      <section className="card section">
        <h2>{t('caches.tmdb')}</h2>
        <p className="muted">{t('caches.tmdbHint')}</p>
        {!tmdbConfigured && <p className="muted">{t('caches.noTmdbKey')}</p>}
        <p>
          {t('caches.tmdbNumbers', { entries: stats.tmdb.entries, found: stats.tmdb.found, misses: stats.tmdb.misses })}
          {' · '}
          {t('caches.expired', { count: stats.tmdb.expired })}
          {' · '}
          {t('caches.oldest', { date: since(stats.tmdb.oldest) })}
        </p>
        {stats.coverage && (
          <>
            <progress max={stats.coverage.total} value={stats.coverage.cached} style={{ width: '100%' }} />
            <p className="muted">{t('caches.coverage', stats.coverage)}</p>
          </>
        )}
        {stats.job.running && <p role="status">{t('caches.refreshing')}</p>}
        {!stats.job.running && stats.job.looked !== null && (
          <p className="muted">{t('caches.refreshed', { count: stats.job.looked })}</p>
        )}
        {stats.job.error && <p className="error">{stats.job.error}</p>}
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {button('tmdb.refresh', t('caches.refreshNow'), { disabled: !tmdbConfigured || stats.job.running })}
          {button('tmdb.retryMisses', t('caches.retryMisses'), { outlined: true, disabled: stats.tmdb.misses === 0 })}
          {button('tmdb.clear', t('caches.clear'), { outlined: true, confirm: true })}
        </div>
      </section>

      <section className="card section">
        <h2>{t('caches.library')}</h2>
        <p className="muted">{t('caches.libraryHint')}</p>
        <table>
          <tbody>
            {stats.library.map((row) => (
              <tr key={row.serverId}>
                <td>{row.label}</td>
                <td>{t('caches.libraryNumbers', { items: row.items, sections: row.sections })}</td>
                <td className="muted">{t('caches.age', { age: age(row.ageMs) })}</td>
              </tr>
            ))}
            {stats.library.length === 0 && (
              <tr>
                <td className="muted">{t('caches.libraryCold')}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="row" style={{ gap: 10 }}>{button('library.refresh', t('caches.refreshNow'))}</div>
      </section>

      <section className="card section">
        <h2>{t('caches.geoip')}</h2>
        <p>
          {t('caches.entries', { count: stats.geoip.entries })} · {t('caches.oldest', { date: since(stats.geoip.oldest) })}
        </p>
        <div className="row" style={{ gap: 10 }}>
          {button('geoip.clear', t('caches.clear'), { outlined: true, confirm: true, disabled: stats.geoip.entries === 0 })}
        </div>
      </section>

      <section className="card section">
        <h2>{t('caches.suggestions')}</h2>
        <p>
          {t('caches.entries', { count: stats.suggestions.entries })} · {t('caches.expired', { count: stats.suggestions.expired })}
        </p>
        <div className="row" style={{ gap: 10 }}>
          {button('suggestions.clear', t('caches.clear'), { outlined: true, confirm: true, disabled: stats.suggestions.entries === 0 })}
        </div>
      </section>
      {note && <p className="muted">{note}</p>}
    </>
  );
}
