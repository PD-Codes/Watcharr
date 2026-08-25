import { NextResponse } from 'next/server';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { getAdapter, getServer, listServers } from '@/server/config';
import { createSession, recordLogin } from '@/server/session';

/** Username/password login for Jellyfin and Emby. Plex uses the PIN routes instead. */
export async function POST(request: Request) {
  const { username, password, serverId } = (await request.json()) as {
    username?: string;
    password?: string;
    serverId?: number;
  };
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
  }

  const server = serverId ? await getServer(serverId) : (await listServers())[0];
  if (!server) return NextResponse.json({ error: 'Unknown server' }, { status: 400 });

  // Keyed per server: an attack on one server must not lock people out of the others.
  if (!rateLimit(`login:${server.id}:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: 'Too many attempts, try again later' }, { status: 429 });
  }

  const meta = { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined };
  const adapter = await getAdapter(server.id);
  try {
    const { user, token } = await adapter.login({ kind: 'password', username, password });
    await createSession(server.id, user, token, meta);
    return NextResponse.json({ ok: true, isAdmin: user.isAdmin });
  } catch {
    void recordLogin(server.id, username, false, meta);
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }
}
