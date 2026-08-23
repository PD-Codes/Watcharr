import { NextResponse } from 'next/server';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { getAdapter } from '@/server/config';
import { createSession } from '@/server/session';

/** Username/password login for Jellyfin and Emby. Plex uses the PIN routes instead. */
export async function POST(request: Request) {
  if (!rateLimit(`login:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: 'Too many attempts, try again later' }, { status: 429 });
  }

  const { username, password } = (await request.json()) as {
    username?: string;
    password?: string;
  };
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
  }

  const adapter = await getAdapter();
  try {
    const { user, token } = await adapter.login({ kind: 'password', username, password });
    await createSession(user, token);
    return NextResponse.json({ ok: true, isAdmin: user.isAdmin });
  } catch {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }
}
