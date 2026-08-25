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
  return NextResponse.json(await adapter.startPinAuth());
}
