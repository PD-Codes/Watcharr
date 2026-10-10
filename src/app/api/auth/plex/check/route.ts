import { NextResponse } from 'next/server';
import { supportsPinAuth } from '@/server/adapters';
import { badBody, readBody } from '@/server/body';
import { isUnauthorized } from '@/server/adapters/http';
import { getAdapter, getServer, listServers } from '@/server/config';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { createSession, isPlexPinBound } from '@/server/session';
import { checkSetupToken } from '@/server/setuptoken';

/** Polled by the login page until the user has approved the PIN on plex.tv. */
export async function POST(request: Request) {
  const body = await readBody(request, { serverId: 'number', setupToken: 'string' });
  if (!body) return badBody();
  const pinId = String((body as { pinId?: unknown }).pinId ?? '');
  const serverId = body.serverId;
  // plex.tv pin ids are plain integers; the value ends up in a URL path.
  if (!/^\d{1,20}$/.test(pinId)) {
    return NextResponse.json({ error: 'pinId is required' }, { status: 400 });
  }
  // Only the browser that started this PIN may collect its sign-in (see bindPlexPin).
  if (!(await isPlexPinBound(pinId))) {
    return NextResponse.json({ error: 'This sign-in was started in another browser' }, { status: 400 });
  }

  const server = serverId ? await getServer(serverId) : (await listServers())[0];
  if (!server) return NextResponse.json({ error: 'Unknown server' }, { status: 400 });

  if (!rateLimit(`plexpin:${server.id}:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ error: 'Too many attempts, try again later' }, { status: 429 });
  }

  // Before the PIN is polled: a wrong token ends the flow instead of burning an approval.
  const ip = clientIp(request);
  const setup = await checkSetupToken(body.setupToken, ip);
  if (setup === 'invalid' || setup === 'limited') {
    return NextResponse.json(
      { error: setup === 'limited' ? 'Too many attempts, try again later' : 'Invalid setup token', code: 'setup-token' },
      { status: setup === 'limited' ? 429 : 401 },
    );
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
    // plex.tv answers 404 for an expired or unknown PIN: the flow is over, not a server fault.
    const status = (error as { status?: number } | null)?.status;
    if (status && status >= 400 && status < 500) {
      return NextResponse.json({ error: 'The PIN has expired, start again' }, { status: 410 });
    }
    throw error;
  }
  if (!result) return NextResponse.json({ pending: true });

  await createSession(
    server.id,
    result.user,
    result.token,
    { ip, userAgent: request.headers.get('user-agent') ?? undefined },
    { claimAdmin: setup === 'valid' },
  );
  return NextResponse.json({ ok: true, isAdmin: result.user.isAdmin });
}
