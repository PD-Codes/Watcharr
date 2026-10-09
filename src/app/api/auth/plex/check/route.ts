import { NextResponse } from 'next/server';
import { supportsPinAuth } from '@/server/adapters';
import { badBody, readBody } from '@/server/body';
import { isUnauthorized } from '@/server/adapters/http';
import { getAdapter, getServer, listServers } from '@/server/config';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { createSession } from '@/server/session';

/** Polled by the login page until the user has approved the PIN on plex.tv. */
export async function POST(request: Request) {
  const body = await readBody(request, { serverId: 'number' });
  if (!body) return badBody();
  const pinId = String((body as { pinId?: unknown }).pinId ?? '');
  const serverId = body.serverId;
  // plex.tv pin ids are plain integers; the value ends up in a URL path.
  if (!/^\d{1,20}$/.test(pinId)) {
    return NextResponse.json({ error: 'pinId is required' }, { status: 400 });
  }

  const server = serverId ? await getServer(serverId) : (await listServers())[0];
  if (!server) return NextResponse.json({ error: 'Unknown server' }, { status: 400 });

  if (!rateLimit(`plexpin:${server.id}:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ error: 'Too many attempts, try again later' }, { status: 429 });
  }

  const adapter = await getAdapter(server.id);
  if (!supportsPinAuth(adapter)) {
    return NextResponse.json({ error: 'PIN auth is not supported' }, { status: 400 });
  }

  let result;
  try {
    result = await adapter.pollPinAuth(pinId);
  } catch (error) {
    // The PIN was approved, but by an account this server does not know.
    if (isUnauthorized(error)) {
      return NextResponse.json({ error: 'This Plex account has no access to this server' }, { status: 403 });
    }
    throw error;
  }
  if (!result) return NextResponse.json({ pending: true });

  await createSession(server.id, result.user, result.token, {
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
  });
  return NextResponse.json({ ok: true, isAdmin: result.user.isAdmin });
}
