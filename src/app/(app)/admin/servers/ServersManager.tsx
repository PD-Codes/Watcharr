'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
      setError(((await res.json()) as { error?: string }).error ?? 'Something went wrong');
    }
  }

  async function onAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await send('POST', Object.fromEntries(form), 'Server added.');
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
      'Saved.',
    );
  }

  async function onDelete(server: ServerCard) {
    const typed = window.prompt(
      `Removing "${server.label}" deletes its accounts and their history in Watcharr. Type the name to confirm:`,
    );
    if (typed !== server.label) return;
    await send('DELETE', { id: server.id }, 'Server removed.');
  }

  return (
    <>
      {servers.map((server) => (
        <form key={server.id} className="card section" onSubmit={(e) => onUpdate(e, server.id)}>
          <p className="stat-label">
            {server.serverType} · /{server.slug} · added {server.addedAt}
          </p>
          <label>
            Name
            <input name="label" defaultValue={server.label} required />
          </label>
          <label>
            Server URL
            <input name="serverUrl" defaultValue={server.serverUrl} required />
          </label>
          <label>
            Admin API token
            <input name="serverToken" type="password" placeholder="unchanged" />
          </label>
          <div className="row" style={{ gap: 10, marginTop: 12 }}>
            <button disabled={busy}>Save</button>
            {server.id !== currentServerId && (
              <button type="button" className="outlined" disabled={busy} onClick={() => onDelete(server)}>
                Remove
              </button>
            )}
          </div>
        </form>
      ))}

      <h2 className="section">Add a server</h2>
      <form className="card" onSubmit={onAdd} style={{ maxWidth: 520 }}>
        <label>
          Name
          <input name="label" placeholder="Plex Server Dome" required />
        </label>
        <label>
          Type
          <select name="serverType" defaultValue="jellyfin">
            {SERVER_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Server URL
          <input name="serverUrl" placeholder="http://192.168.1.10:8096" required />
        </label>
        <label>
          Admin API token
          <input name="serverToken" type="password" required />
        </label>
        <button disabled={busy} style={{ marginTop: 12 }}>
          Add server
        </button>
      </form>

      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}
