import { NextResponse } from 'next/server';
import { supportsPinAuth, type AuthResult } from '@/server/adapters';
import { readBody } from '@/server/body';
import { isUnauthorized } from '@/server/adapters/http';
import { getAdapter, getServer, listServers } from '@/server/config';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { createSession, isPlexPinBound } from '@/server/session';
import { checkSetupToken } from '@/server/setuptoken';
import { apiError, badBody } from '@/server/apierror';

/** Polled by the login page until the user has approved the PIN on plex.tv. */
export async function POST(request: Request) {
  const body = await readBody(request, { serverId: 'number', setupToken: 'string' });
  if (!body) return badBody();
  const pinId = String((body as { pinId?: unknown }).pinId ?? '');
  const serverId = body.serverId;
  // plex.tv pin ids are plain integers; the value ends up in a URL path.
  if (!/^\d{1,20}$/.test(pinId)) {
    return apiError(400, 'missing-pin', 'err.pinIdRequired');
  }
  // Only the browser that started this PIN may collect its sign-in (see bindPlexPin).
  if (!(await isPlexPinBound(pinId))) {
    return apiError(400, 'unbound', 'err.otherBrowser');
  }

  const server = serverId ? await getServer(serverId) : (await listServers())[0];
  if (!server) return apiError(400, 'unknown-server', 'err.unknownServer');

  if (!rateLimit(`plexpin:${server.id}:${clientIp(request)}`, 120, 60_000)) {
    return apiError(429, 'limited', 'err.limited');
  }

  // Before the PIN is polled: a wrong token ends the flow instead of burning an approval.
  const ip = clientIp(request);
  const setup = await checkSetupToken(body.setupToken, ip);
  if (setup === 'invalid' || setup === 'limited') {
    return apiError(
      setup === 'limited' ? 429 : 401,
      'setup-token',
      setup === 'limited' ? 'err.limited' : 'err.setupTokenInvalid',
    );
  }

  const adapter = await getAdapter(server.id);
  if (!supportsPinAuth(adapter)) {
    return apiError(400, 'unsupported', 'err.pinUnsupported');
  }

  let result: AuthResult | null;
  try {
    result = await adapter.pollPinAuth(pinId);
  } catch (error) {
    // The PIN was approved, but by an account this server does not know.
    if (isUnauthorized(error)) {
      return apiError(403, 'no-access', 'err.plexNoAccess');
    }
    // plex.tv answers 404 for an expired or unknown PIN: the flow is over, not a server fault.
    const status = (error as { status?: number } | null)?.status;
    if (status && status >= 400 && status < 500) {
      return apiError(410, 'expired', 'err.pinExpired');
    }
    // plex.tv or the media server too slow: the PIN stays valid and the login page simply asks
    // again on its next tick, so this is a warning with the host, not an unhandled stack trace.
    if ((error as Error | null)?.name === 'TimeoutError') {
      console.warn(`[watcharr] Plex sign-in: ${(error as Error).message}; the login page retries`);
      return apiError(504, 'timeout', 'err.plexTimeout');
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
