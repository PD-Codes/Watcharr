import { NextResponse } from 'next/server';
import { supportsPinAuth } from '@/server/adapters';
import { getAdapter, getServer, listServers } from '@/server/config';

/** Starts the Plex PIN OAuth flow and returns the URL the user has to visit. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { serverId?: number } | null;
  const server = body?.serverId ? await getServer(body.serverId) : (await listServers())[0];
  if (!server) return NextResponse.json({ error: 'Unknown server' }, { status: 400 });

  const adapter = await getAdapter(server.id);
  if (!supportsPinAuth(adapter)) {
    return NextResponse.json({ error: 'PIN auth is not supported' }, { status: 400 });
  }
  // The browser's own origin (a same-origin POST always carries it) beats APP_URL, which may
  // name another address than the one this person is using right now.
  const base = (request.headers.get('origin') ?? process.env.APP_URL ?? '').trim().replace(/\/$/, '');
  const forward = /^https?:\/\/[^\s/]+$/.test(base)
    ? (pinId: string) => `${base}/login/plex-done?pin=${pinId}&server=${server.id}`
    : undefined;
  return NextResponse.json(await adapter.startPinAuth(forward));
}
