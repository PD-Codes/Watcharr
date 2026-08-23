import { NextResponse } from 'next/server';
import { supportsPinAuth } from '@/server/adapters';
import { getAdapter } from '@/server/config';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { createSession } from '@/server/session';

/** Polled by the login page until the user has approved the PIN on plex.tv. */
export async function POST(request: Request) {
  if (!rateLimit(`plexpin:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ error: 'Too many attempts, try again later' }, { status: 429 });
  }

  const { pinId } = (await request.json()) as { pinId?: string };
  if (!pinId) return NextResponse.json({ error: 'pinId is required' }, { status: 400 });

  const adapter = await getAdapter();
  if (!supportsPinAuth(adapter)) {
    return NextResponse.json({ error: 'PIN auth is not supported' }, { status: 400 });
  }

  const result = await adapter.pollPinAuth(pinId);
  if (!result) return NextResponse.json({ pending: true });

  await createSession(result.user, result.token);
  return NextResponse.json({ ok: true, isAdmin: result.user.isAdmin });
}
