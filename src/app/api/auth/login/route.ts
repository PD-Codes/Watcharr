import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { clearRateLimit, clientIp, isRateLimited, rateLimit } from '@/server/ratelimit';
import type { HttpError } from '@/server/adapters/http';
import { getAdapter, getServer, listServers } from '@/server/config';
import { createSession, recordLogin } from '@/server/session';
import { checkSetupToken } from '@/server/setuptoken';
import { apiError, badBody } from '@/server/apierror';

/** Username/password login for Jellyfin and Emby. Plex uses the PIN routes instead. */
export async function POST(request: Request) {
  const body = await readBody(request, { username: 'string', password: 'string', serverId: 'number', setupToken: 'string' });
  if (!body) return badBody();
  const { username, password, serverId } = body;
  if (!username || !password) {
    return apiError(400, 'missing-credentials', 'err.credentialsRequired');
  }

  const server = serverId ? await getServer(serverId) : (await listServers())[0];
  if (!server) return apiError(400, 'unknown-server', 'err.unknownServer');

  // Keyed per server: an attack on one server must not lock people out of the others.
  // The address is whatever X-Forwarded-For says, so a client can change it at will — the
  // second limiter, on the account being guessed, is the one that does not depend on it.
  // It counts failures only and expires by itself. The price: anyone can lock a known
  // account out for the length of that window, which is accepted over a limit that
  // changing the address defeats.
  const ip = clientIp(request);
  const account = `login-user:${server.id}:${username.trim().toLowerCase().slice(0, 128)}`;
  if (!rateLimit(`login:${server.id}:${ip}`, 10, 60_000) || isRateLimited(account, 10)) {
    return apiError(429, 'limited', 'err.limited');
  }

  const meta = { ip, userAgent: request.headers.get('user-agent') ?? undefined };
  const adapter = await getAdapter(server.id);
  try {
    const { user, token } = await adapter.login({ kind: 'password', username, password });
    // Checked after the password: the token only ever upgrades an account that exists.
    const setup = await checkSetupToken(body.setupToken, ip);
    if (setup === 'invalid' || setup === 'limited') {
      return apiError(
        setup === 'limited' ? 429 : 401,
        'setup-token',
        setup === 'limited' ? 'err.limited' : 'err.setupTokenInvalid',
      );
    }
    await createSession(server.id, user, token, meta, { claimAdmin: setup === 'valid' });
    clearRateLimit(account);
    return NextResponse.json({ ok: true, isAdmin: user.isAdmin });
  } catch (error) {
    // Only a refusal by the media server counts toward the account lock. A timeout, a 5xx or
    // a database error says nothing about the password, and counting it would let an outage
    // lock every user out for the length of the window.
    const status = (error as HttpError | null)?.status;
    if (status !== undefined && status < 500) rateLimit(account, 10, 10 * 60_000);
    void recordLogin(server.id, username, false, meta);
    return apiError(401, 'invalid-credentials', 'err.invalidCredentials');
  }
}
