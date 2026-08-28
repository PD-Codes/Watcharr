'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

interface Summary {
  candidates: number;
  plays: number;
  streams: number;
  unmatchedUsers: string[];
}

/**
 * The preview is not optional politeness: an import merges somebody else's years of data
 * into a live history, and the one thing that goes wrong is a name that does not match, so
 * "which users did this not find" has to be answerable before anything is written.
 */
export default function ImportForm({ servers }: { servers: { id: number; label: string }[] }) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Summary | null>(null);
  const [done, setDone] = useState<Summary | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Which button was pressed, rather than two handlers over one form: the fields are the
    // same either way, and the difference is one boolean in the request.
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const dryRun = submitter?.value !== 'run';
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    if (dryRun) setDone(null);

    const res = await fetch('/api/admin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: String(form.get('path') ?? ''),
        serverId: Number(form.get('serverId')),
        days: form.get('days') ? Number(form.get('days')) : undefined,
        dryRun,
      }),
    });
    setBusy(false);
    const body = (await res.json()) as Summary & { error?: string };
    if (!res.ok) {
      setError(body.error ?? t('error.generic'));
      return;
    }
    if (dryRun) {
      setPreview(body);
    } else {
      setDone(body);
      setPreview(null);
      router.refresh();
    }
  }

  function summary(data: Summary, label: string) {
    return (
      <div className="card section">
        <p className="stat-label">{label}</p>
        <p>
          {t('import.resultPlays', { plays: data.plays, streams: data.streams })}{' '}
          <span className="muted">{t('import.resultRows', { rows: data.candidates })}</span>
        </p>
        {data.unmatchedUsers.length > 0 && (
          <p className="muted">
            {t('import.unmatched', { users: data.unmatchedUsers.join(', ') })}
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <form className="card" onSubmit={onSubmit} style={{ maxWidth: 520 }}>
        <label>
          {t('import.server')}
          <select name="serverId" defaultValue={servers[0]?.id}>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('import.path')}
          <input name="path" required placeholder="/data/tautulli/tautulli.db" />
        </label>
        <p className="muted" style={{ marginTop: -6 }}>
          {t('import.pathHint')}
        </p>
        <label>
          {t('import.days')}
          <input name="days" type="number" min={1} placeholder={t('import.everything')} />
        </label>

        <div className="row" style={{ gap: 10, marginTop: 12 }}>
          <button type="submit" name="mode" value="preview" className="outlined" disabled={busy}>
            {busy ? t('import.working') : t('import.preview')}
          </button>
          {/* Only reachable after a preview: the numbers above are what is being confirmed. */}
          {preview && (
            <button type="submit" name="mode" value="run" disabled={busy}>
              {t('import.run')}
            </button>
          )}
        </div>
      </form>

      {preview && summary(preview, t('import.previewResult'))}
      {done && summary(done, t('import.doneResult'))}
      {error && <p className="error">{error}</p>}
    </>
  );
}
