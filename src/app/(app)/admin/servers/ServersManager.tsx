'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

export interface ServerCard {
  id: number;
  label: string;
  slug: string;
  serverType: string;
  serverUrl: string;
  serverName: string | null;
  addedAt: string;
}

const SERVER_TYPES = ['jellyfin', 'emby', 'plex'] as const;

export default function ServersManager({
  servers,
  currentServerId,
}: {
  servers: ServerCard[];
  /** The server this admin signed in through; it cannot be removed from under them. */
  currentServerId: number;
}) {
  const router = useRouter();
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(method: 'POST' | 'PATCH' | 'DELETE', body: unknown, done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await fetch('/api/admin/servers', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) {
      setMessage(done);
      router.refresh();
    } else {
      setError(((await res.json()) as { error?: string }).error ?? t('error.generic'));
    }
  }

  async function onAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await send('POST', Object.fromEntries(form), t('servers.added'));
    event.currentTarget.reset();
  }

  async function onUpdate(event: React.FormEvent<HTMLFormElement>, id: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await send(
      'PATCH',
      {
        id,
        label: String(form.get('label') ?? ''),
        serverUrl: String(form.get('serverUrl') ?? ''),
        serverToken: String(form.get('serverToken') ?? '') || undefined,
      },
      t('action.saved'),
    );
  }

  async function onDelete(server: ServerCard) {
    const typed = window.prompt(t('servers.confirmRemove', { label: server.label }));
    if (typed !== server.label) return;
    await send('DELETE', { id: server.id }, t('servers.removed'));
  }

  return (
    <>
      {servers.map((server) => (
        <form key={server.id} className="card section" onSubmit={(e) => onUpdate(e, server.id)}>
          <p className="stat-label">
            {t('servers.cardMeta', {
              type: server.serverType,
              slug: server.slug,
              date: server.addedAt,
            })}
          </p>
          <label>
            {t('servers.name')}
            <input name="label" defaultValue={server.label} required />
          </label>
          <label>
            {t('servers.url')}
            <input name="serverUrl" defaultValue={server.serverUrl} required />
          </label>
          <label>
            {t('servers.token')}
            <input name="serverToken" type="password" placeholder={t('servers.tokenUnchanged')} />
          </label>
          <div className="row" style={{ gap: 10, marginTop: 12 }}>
            <button disabled={busy}>{t('action.save')}</button>
            {server.id !== currentServerId && (
              <button type="button" className="outlined" disabled={busy} onClick={() => onDelete(server)}>
                {t('servers.remove')}
              </button>
            )}
          </div>
        </form>
      ))}

      <h2 className="section">{t('servers.add')}</h2>
      <form className="card" onSubmit={onAdd} style={{ maxWidth: 520 }}>
        <label>
          {t('servers.name')}
          <input name="label" placeholder="Plex Server Dome" required />
        </label>
        <label>
          {t('servers.type')}
          <select name="serverType" defaultValue="jellyfin">
            {SERVER_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('servers.url')}
          <input name="serverUrl" placeholder="http://192.168.1.10:8096" required />
        </label>
        <label>
          {t('servers.token')}
          <input name="serverToken" type="password" required />
        </label>
        <button disabled={busy} style={{ marginTop: 12 }}>
          {t('servers.addButton')}
        </button>
      </form>

      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}
