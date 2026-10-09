'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

// Types mirrored from the server modules, which are server-only and cannot be imported here.
interface Summary {
  candidates: number;
  plays: number;
  streams: number;
  createdUsers: number;
  logins: number;
  unmatched: { name: string; rows: number }[];
  scanned: number;
  total: number;
}
interface Job {
  id: string;
  status: 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';
  params: { dryRun: boolean; serverId: number };
  label: string;
  summary: Summary | null;
  error?: string;
}
interface Upload {
  id: string;
  name: string;
  size: number;
  received: number;
  complete: boolean;
}
interface Account {
  id: number;
  serverId: number;
  username: string;
}

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(bytes > 1024 ** 3 ? 0 : 1)} MB`;

/**
 * A preview and then the real run, both as background jobs the page merely watches. The
 * preview is not optional politeness: an import merges somebody else's years of data into a
 * live history, and the one thing that goes wrong is a name that does not match, so "which
 * users did this not find" — and the chance to pair them by hand — comes before any write.
 */
export default function ImportForm({
  servers,
  accounts,
  initialUploads,
  initialJob,
  chunkBytes,
}: {
  servers: { id: number; label: string }[];
  accounts: Account[];
  initialUploads: Upload[];
  initialJob: Job | null;
  chunkBytes: number;
}) {
  const router = useRouter();
  const t = useT();
  const [source, setSource] = useState<'upload' | 'path'>('upload');
  const [serverId, setServerId] = useState(servers[0]?.id ?? 0);
  const [uploads, setUploads] = useState(initialUploads);
  const [selected, setSelected] = useState<string | null>(initialUploads.find((u) => u.complete)?.id ?? null);
  const [sending, setSending] = useState<{ name: string; sent: number; size: number } | null>(null);
  const [job, setJob] = useState<Job | null>(initialJob);
  const [map, setMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when a form field changes after the preview: its numbers no longer describe the form.
  const [stale, setStale] = useState(false);
  const [createUsers, setCreateUsers] = useState(true);
  const [logins, setLogins] = useState(true);
  const formRef = useRef<HTMLFormElement>(null);
  const abort = useRef(false);

  // Poll while a job runs. 1 s is cheap (one small JSON read) and feels live.
  useEffect(() => {
    if (job?.status !== 'running') return;
    const timer = setInterval(async () => {
      const res = await fetch('/api/admin/import').catch(() => null);
      const body = (await res?.json().catch(() => null)) as { job: Job | null } | null;
      if (body?.job) setJob(body.job);
      if (body?.job && body.job.status !== 'running') router.refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.status, router]);

  const refreshUploads = useCallback(async () => {
    const res = await fetch('/api/admin/import/upload');
    if (res.ok) setUploads(((await res.json()) as { uploads: Upload[] }).uploads);
  }, []);

  /** Sends the file in slices. A dropped connection resumes from what the server holds. */
  async function sendFile(file: File) {
    setError(null);
    abort.current = false;
    try {
      // Same name and size, not finished: this is the interrupted upload — continue it.
      let upload = uploads.find((u) => !u.complete && u.size === file.size && u.name === file.name);
      if (!upload) {
        const res = await fetch('/api/admin/import/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, size: file.size }),
        });
        const body = (await res.json().catch(() => ({}))) as { upload?: Upload; error?: string };
        if (!res.ok || !body.upload) throw new Error(body.error ?? t('error.generic'));
        upload = body.upload;
      }
      let offset = upload.received;
      let failures = 0;
      while (offset < file.size && !abort.current) {
        setSending({ name: file.name, sent: offset, size: file.size });
        try {
          const res = await fetch(`/api/admin/import/upload?id=${upload.id}&offset=${offset}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file.slice(offset, Math.min(offset + chunkBytes, file.size)),
          });
          const body = (await res.json().catch(() => ({}))) as { upload?: Upload; error?: string; received?: number };
          if (res.status === 409 && body.received !== undefined) {
            offset = body.received; // the server is somewhere else than we thought: follow it
            continue;
          }
          if (!res.ok || !body.upload) throw new Error(body.error ?? String(res.status));
          offset = body.upload.received;
          failures = 0;
        } catch (e) {
          // 4xx other than 409 are final; a network error or a 5xx is worth another go.
          if (++failures > 5 || (e instanceof Error && /^4\d\d$|not a SQLite/.test(e.message))) throw e;
          await new Promise((r) => setTimeout(r, 1000 * failures));
          const check = await fetch(`/api/admin/import/upload?id=${upload.id}`).catch(() => null);
          const info = (await check?.json().catch(() => null)) as { upload?: Upload } | null;
          if (info?.upload) offset = info.upload.received;
        }
      }
      await refreshUploads();
      if (!abort.current) setSelected(upload.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error.generic'));
      await refreshUploads();
    } finally {
      setSending(null);
    }
  }

  async function start(dryRun: boolean, resume = false) {
    const form = new FormData(formRef.current ?? undefined);
    setBusy(true);
    setError(null);
    const userMap: Record<string, number | null> = {};
    // '' is the default (create, or report when creating is off); 'skip' is an explicit no.
    for (const [name, value] of Object.entries(map)) {
      if (value) userMap[name] = value === 'skip' ? null : Number(value);
    }
    try {
      const res = await fetch('/api/admin/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resume,
          dryRun,
          serverId,
          uploadId: source === 'upload' ? selected : undefined,
          path: source === 'path' ? String(form.get('path') ?? '') : undefined,
          days: form.get('days') ? Number(form.get('days')) : undefined,
          backup: form.get('backup') === 'on',
          createUsers,
          logins,
          // The mapping only exists after a preview, and only applies to the real run.
          userMap: dryRun ? undefined : userMap,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { job?: Job; error?: string };
      if (!res.ok || !body.job) setError(body.error ?? t('error.generic'));
      else {
        setJob(body.job);
        setStale(false);
      }
    } catch {
      setError(t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    await fetch('/api/admin/import', { method: 'DELETE' });
  }

  async function remove(id: string) {
    await fetch(`/api/admin/import/upload?id=${id}`, { method: 'DELETE' });
    if (selected === id) setSelected(null);
    await refreshUploads();
  }

  const running = job?.status === 'running';
  const summary = job?.summary;
  const percent = summary && summary.total ? Math.min(100, Math.floor((summary.scanned / summary.total) * 100)) : 0;
  const previewReady = job?.status === 'done' && job.params.dryRun && !stale;
  const canStart = !running && !sending && (source === 'path' || selected !== null);
  const choices = accounts.filter((a) => a.serverId === serverId);

  return (
    <>
      {/* A changed field invalidates the preview: "Import" must run what was previewed. */}
      <form
        ref={formRef}
        className="card"
        onSubmit={(e) => e.preventDefault()}
        onChange={() => setStale(true)}
        style={{ maxWidth: 620 }}
      >
        <label>
          {t('import.server')}
          <select name="serverId" value={serverId} onChange={(e) => setServerId(Number(e.target.value))}>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset style={{ border: 0, padding: 0, margin: '12px 0' }}>
          <legend className="stat-label">{t('import.source')}</legend>
          <label className="row">
            <input type="radio" checked={source === 'upload'} onChange={() => setSource('upload')} />
            {t('import.sourceUpload')}
          </label>
          <label className="row">
            <input type="radio" checked={source === 'path'} onChange={() => setSource('path')} />
            {t('import.sourcePath')}
          </label>
        </fieldset>

        {source === 'upload' ? (
          <>
            <label>
              {t('import.chooseFile')}
              <input
                type="file"
                accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/octet-stream"
                disabled={!!sending || running}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void sendFile(file);
                  e.target.value = '';
                }}
              />
            </label>
            <p className="muted" style={{ marginTop: -6 }}>{t('import.uploadHint')}</p>
            {sending && (
              <div role="status">
                <progress max={sending.size} value={sending.sent} style={{ width: '100%' }} />
                <p className="muted">
                  {t('import.uploading', { name: sending.name, sent: mb(sending.sent), size: mb(sending.size) })}{' '}
                  <button type="button" className="link" onClick={() => (abort.current = true)}>
                    {t('import.pause')}
                  </button>
                </p>
              </div>
            )}
            {uploads.length > 0 && (
              <table style={{ marginTop: 8 }}>
                <tbody>
                  {uploads.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <label className="row">
                          <input
                            type="radio"
                            name="upload"
                            disabled={!u.complete}
                            checked={selected === u.id}
                            onChange={() => setSelected(u.id)}
                          />
                          {u.name}
                        </label>
                      </td>
                      <td className="muted">
                        {u.complete ? mb(u.size) : t('import.partial', { percent: Math.floor((u.received / u.size) * 100) })}
                      </td>
                      <td>
                        <button type="button" className="link" onClick={() => void remove(u.id)}>
                          {t('action.delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <>
            <label>
              {t('import.path')}
              <input name="path" placeholder="/data/tautulli/tautulli.db" />
            </label>
            <p className="muted" style={{ marginTop: -6 }}>{t('import.pathHint')}</p>
          </>
        )}

        <label>
          {t('import.days')}
          <input name="days" type="number" min={1} placeholder={t('import.everything')} />
        </label>

        <label className="row">
          <input type="checkbox" name="backup" defaultChecked />
          {t('import.safetyBackup')}
        </label>
        <label className="row">
          <input type="checkbox" checked={createUsers} onChange={(e) => setCreateUsers(e.target.checked)} />
          {t('import.createUsers')}
        </label>
        <label className="row">
          <input type="checkbox" checked={logins} onChange={(e) => setLogins(e.target.checked)} />
          {t('import.logins')}
        </label>

        <div className="row" style={{ gap: 10, marginTop: 12 }}>
          <button type="button" className="outlined" disabled={!canStart || busy} onClick={() => void start(true)}>
            {t('import.preview')}
          </button>
          {/* Only reachable after a finished preview: the numbers below are what is being confirmed. */}
          {previewReady && (
            <button type="button" disabled={busy || !!sending} onClick={() => void start(false)}>
              {t('import.run')}
            </button>
          )}
        </div>
      </form>

      {job && (
        <div className="card section" style={{ maxWidth: 620 }} aria-live="polite">
          <p className="stat-label">
            {job.params.dryRun ? t('import.previewResult') : t('import.doneResult')} · {job.label} ·{' '}
            {t(`import.status.${job.status}` as 'import.status.running')}
          </p>
          {summary && (
            <>
              <progress max={100} value={percent} style={{ width: '100%' }} />
              <p className="muted">{t('import.progress', { scanned: summary.scanned, total: summary.total, percent })}</p>
              <p>
                {t('import.resultPlays', { plays: summary.plays, streams: summary.streams })}{' '}
                <span className="muted">{t('import.resultRows', { rows: summary.candidates })}</span>
              </p>
              <p>{t('import.resultExtra', { users: summary.createdUsers ?? 0, logins: summary.logins ?? 0 })}</p>
            </>
          )}
          {running && (
            <button type="button" className="outlined" onClick={() => void stop()}>
              {t('import.stop')}
            </button>
          )}
          {(job.status === 'interrupted' || job.status === 'stopped' || job.status === 'failed') && !job.params.dryRun && (
            <button type="button" onClick={() => void start(false, true)} disabled={busy}>
              {t('import.resume')}
            </button>
          )}
          {job.error && <p className="error">{job.error}</p>}

          {previewReady && summary && summary.unmatched.length > 0 && (
            <>
              <p className="stat-label" style={{ marginTop: 16 }}>{t('import.mapTitle')}</p>
              <p className="muted">{t('import.mapHint')}</p>
              <table>
                <tbody>
                  {summary.unmatched.map((u) => (
                    <tr key={u.name}>
                      <td>
                        {u.name} <span className="muted">· {t('import.mapRows', { rows: u.rows })}</span>
                      </td>
                      <td>
                        <select
                          aria-label={u.name}
                          value={map[u.name] ?? ''}
                          onChange={(e) => setMap({ ...map, [u.name]: e.target.value })}
                        >
                          <option value="">{t(createUsers ? 'import.mapCreate' : 'import.mapSkip')}</option>
                          {createUsers && <option value="skip">{t('import.mapSkip')}</option>}
                          {choices.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.username}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
