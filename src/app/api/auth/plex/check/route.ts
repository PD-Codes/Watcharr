import { NextResponse } from 'next/server';
import { supportsPinAuth } from '@/server/adapters';
import { getAdapter, getServer, listServers } from '@/server/config';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { createSession } from '@/server/session';

/** Polled by the login page until the user has approved the PIN on plex.tv. */
export async function POST(request: Request) {
  const { pinId, serverId } = (await request.json()) as { pinId?: string; serverId?: number };
  if (!pinId) return NextResponse.json({ error: 'pinId is required' }, { status: 400 });

  const server = serverId ? await getServer(serverId) : (await listServers())[0];
  if (!server) return NextResponse.json({ error: 'Unknown server' }, { status: 400 });

  if (!rateLimit(`plexpin:${server.id}:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ error: 'Too many attempts, try again later' }, { status: 429 });
  }

  const adapter = await getAdapter(server.id);
  if (!supportsPinAuth(adapter)) {
    return NextResponse.json({ error: 'PIN auth is not supported' }, { status: 400 });
  }

  const result = await adapter.pollPinAuth(pinId);
  if (!result) return NextResponse.json({ pending: true });

  await createSession(server.id, result.user, result.token, {
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
  });
  return NextResponse.json({ ok: true, isAdmin: result.user.isAdmin });
}
