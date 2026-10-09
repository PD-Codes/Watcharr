'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

interface Backup {
  name: string;
  kind: 'scheduled' | 'manual' | 'pre-restore' | 'pre-import' | 'other';
  size: number;
  createdAt: string;
}
interface Verdict {
  ok: boolean;
  error?: string;
  users?: number | null;
  history?: number | null;
  migrations?: number | null;
}

const size = (bytes: number) =>
  bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export default function BackupsManager({
  backups,
  pending,
  canRestart,
}: {
  backups: Backup[];
  pending: string | null;
  canRestart: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: string, name?: string, key = action) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        result?: Verdict;
      };
      if (action === 'verify' && body.result && name) setVerdicts((v) => ({ ...v, [name]: body.result! }));
      else if (!res.ok) setError(body.error ?? t('error.generic'));
      else if (action === 'restart') setMessage(t('backups.restarting'));
      else router.refresh();
    } catch {
      setError(t('error.generic'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {pending && (
        <div className="card section" role="status">
          <p>
            <strong>{t('backups.pendingTitle', { name: pending })}</strong>
          </p>
          <p className="muted">{canRestart ? t('backups.pendingHintDocker') : t('backups.pendingHint')}</p>
          <div className="row" style={{ gap: 10 }}>
            {canRestart && (
              <button disabled={busy !== null} onClick={() => window.confirm(t('backups.confirmRestart')) && void act('restart')}>
                {t('backups.restartNow')}
              </button>
            )}
            <button className="outlined" disabled={busy !== null} onClick={() => void act('cancelRestore')}>
              {t('backups.cancelRestore')}
            </button>
          </div>
        </div>
      )}

      <div className="row" style={{ gap: 10, margin: '12px 0' }}>
        <button disabled={busy !== null} onClick={() => void act('create')}>
          {busy === 'create' ? t('backups.creating') : t('backups.create')}
        </button>
        <button className="outlined" onClick={() => window.location.assign("/api/admin/backup")}>{t("system.downloadSnapshot")}</button>
      </div>
      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('backups.colFile')}</th>
              <th scope="col" className="secondary-col">{t('backups.colKind')}</th>
              <th scope="col">{t('backups.colSize')}</th>
              <th scope="col" className="secondary-col">{t('backups.colCreated')}</th>
              <th scope="col">{t('backups.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => {
              const verdict = verdicts[b.name];
              return (
                <tr key={b.name}>
                  <td>
                    {b.name}
                    {verdict && (
                      <p className={verdict.ok ? 'muted' : 'error'}>
                        {verdict.ok
                          ? t('backups.verified', { users: verdict.users ?? 0, history: verdict.history ?? 0 })
                          : (verdict.error ?? t('backups.verifyFailed'))}
                      </p>
                    )}
                  </td>
                  <td className="secondary-col">{t(`backups.kind.${b.kind}` as 'backups.kind.manual')}</td>
                  <td>{size(b.size)}</td>
                  <td className="secondary-col when-cell">{b.createdAt}</td>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <a href={`/api/admin/backup?name=${encodeURIComponent(b.name)}`}>{t('backups.download')}</a>
                      <button className="link" disabled={busy !== null} onClick={() => void act('verify', b.name, `v:${b.name}`)}>
                        {busy === `v:${b.name}` ? t('backups.verifying') : t('backups.verify')}
                      </button>
                      <button
                        className="link"
                        disabled={busy !== null}
                        onClick={() => window.confirm(t('backups.confirmRestore', { name: b.name })) && void act('restore', b.name)}
                      >
                        {t('backups.restore')}
                      </button>
                      <button
                        className="link"
                        disabled={busy !== null}
                        onClick={() => window.confirm(t('backups.confirmDelete', { name: b.name })) && void act('delete', b.name)}
                      >
                        {t('action.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {backups.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">{t('backups.none')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">{t('backups.restoreNote')}</p>
    </>
  );
}
