'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ChannelField {
  key: string;
  label: string;
  type: string;
}
interface ChannelTypeDef {
  type: string;
  label: string;
  fields: readonly ChannelField[];
}
interface EventDef {
  key: string;
  label: string;
}
export interface ChannelCard {
  id: number;
  type: string;
  name: string;
  configuredFields: string[];
  events: string[];
  enabled: boolean;
}

function fieldsFor(channelTypes: readonly ChannelTypeDef[], type: string): readonly ChannelField[] {
  return channelTypes.find((c) => c.type === type)?.fields ?? [];
}

export default function NotificationsManager({
  channels,
  channelTypes,
  events,
}: {
  channels: ChannelCard[];
  channelTypes: readonly ChannelTypeDef[];
  events: readonly EventDef[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newType, setNewType] = useState(channelTypes[0]?.type ?? '');

  async function send(method: 'POST' | 'PATCH' | 'DELETE', body: unknown, done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await fetch('/api/admin/notifications', {
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

  function readConfig(form: FormData, fields: readonly ChannelField[]): Record<string, string> {
    const config: Record<string, string> = {};
    for (const field of fields) {
      const value = String(form.get(`config.${field.key}`) ?? '');
      if (value) config[field.key] = value; // blank = leave unchanged on edit, unset on create
    }
    return config;
  }

  function readEvents(form: FormData): string[] {
    return events.filter((e) => form.get(`event.${e.key}`) === 'on').map((e) => e.key);
  }

  async function onUpdate(event: React.FormEvent<HTMLFormElement>, channel: ChannelCard) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await send(
      'PATCH',
      {
        id: channel.id,
        name: String(form.get('name') ?? ''),
        config: readConfig(form, fieldsFor(channelTypes, channel.type)),
        events: readEvents(form),
        enabled: form.get('enabled') === 'on',
      },
      'Saved.',
    );
  }

  async function onAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await send(
      'POST',
      {
        type: newType,
        name: String(form.get('name') ?? ''),
        config: readConfig(form, fieldsFor(channelTypes, newType)),
        events: readEvents(form),
      },
      'Channel added.',
    );
    event.currentTarget.reset();
  }

  async function onDelete(channel: ChannelCard) {
    if (!window.confirm(`Remove the "${channel.name}" channel?`)) return;
    await send('DELETE', { id: channel.id }, 'Channel removed.');
  }

  async function onTest(id: number) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await fetch('/api/admin/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setBusy(false);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (res.ok && body.ok) setMessage('Test notification sent.');
    else setError(body.error ?? 'Test failed.');
  }

  return (
    <>
      {channels.map((channel) => {
        const fields = fieldsFor(channelTypes, channel.type);
        return (
          <form key={channel.id} className="card section" onSubmit={(e) => onUpdate(e, channel)}>
            <p className="stat-label">
              {channelTypes.find((c) => c.type === channel.type)?.label ?? channel.type}
            </p>
            <label>
              Name
              <input name="name" defaultValue={channel.name} required />
            </label>
            {fields.map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  name={`config.${field.key}`}
                  type={field.type}
                  placeholder={
                    channel.configuredFields.includes(field.key) ? 'configured' : 'not set'
                  }
                />
              </label>
            ))}
            <p className="stat-label" style={{ marginTop: 14 }}>
              Events
            </p>
            {events.map((e) => (
              <label className="row" key={e.key}>
                <input
                  type="checkbox"
                  name={`event.${e.key}`}
                  defaultChecked={channel.events.includes(e.key)}
                  style={{ width: 'auto' }}
                />
                {e.label}
              </label>
            ))}
            <label className="row" style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={channel.enabled}
                style={{ width: 'auto' }}
              />
              Enabled
            </label>
            <div className="row" style={{ gap: 10, marginTop: 12 }}>
              <button disabled={busy}>Save</button>
              <button
                type="button"
                className="outlined"
                disabled={busy}
                onClick={() => onTest(channel.id)}
              >
                Send test
              </button>
              <button
                type="button"
                className="outlined"
                disabled={busy}
                onClick={() => onDelete(channel)}
              >
                Remove
              </button>
            </div>
          </form>
        );
      })}

      <h2 className="section">Add a channel</h2>
      <form className="card" onSubmit={onAdd} style={{ maxWidth: 520 }}>
        <label>
          Type
          <select name="type" value={newType} onChange={(e) => setNewType(e.target.value)}>
            {channelTypes.map((c) => (
              <option key={c.type} value={c.type}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input name="name" placeholder={newType} />
        </label>
        {fieldsFor(channelTypes, newType).map((field) => (
          <label key={field.key}>
            {field.label}
            <input name={`config.${field.key}`} type={field.type} required />
          </label>
        ))}
        <p className="stat-label" style={{ marginTop: 14 }}>
          Events
        </p>
        {events.map((e) => (
          <label className="row" key={e.key}>
            <input type="checkbox" name={`event.${e.key}`} style={{ width: 'auto' }} />
            {e.label}
          </label>
        ))}
        <button disabled={busy} style={{ marginTop: 12 }}>
          Add channel
        </button>
      </form>

      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}
