import { NextResponse } from 'next/server';
import { supportsPinAuth } from '@/server/adapters';
import { badBody, readBody } from '@/server/body';
import { getAdapter, getServer, listServers } from '@/server/config';
import { acceptedHosts } from '@/server/sameorigin';
import { bindPlexPin } from '@/server/session';

/** Starts the Plex PIN OAuth flow and returns the URL the user has to visit. */
export async function POST(request: Request) {
  const body = await readBody(request, { serverId: 'number' });
  if (!body) return badBody();
  const server = body?.serverId ? await getServer(body.serverId) : (await listServers())[0];
  if (!server) return NextResponse.json({ error: 'Unknown server' }, { status: 400 });

  const adapter = await getAdapter(server.id);
  if (!supportsPinAuth(adapter)) {
    return NextResponse.json({ error: 'PIN auth is not supported' }, { status: 400 });
  }
  // The browser's own origin beats APP_URL, which may name another address than the one this
  // person is using right now — but only an origin this app answers as: a script can send any
  // Origin, and plex.tv would then forward the approved PIN to the script's site.
  const origin = request.headers.get('origin');
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host.toLowerCase() : null;
  } catch {
    // not a URL: ignored, APP_URL is used
  }
  const trusted = originHost && acceptedHosts(request.headers).includes(originHost) ? origin : null;
  const base = (trusted ?? process.env.APP_URL ?? '').trim().replace(/\/$/, '');
  const forward = /^https?:\/\/[^\s/]+$/.test(base)
    ? (pinId: string) => `${base}/login/plex-done?pin=${pinId}&server=${server.id}`
    : undefined;
  const pin = await adapter.startPinAuth(forward);
  await bindPlexPin(pin.pinId);
  return NextResponse.json(pin);
}
