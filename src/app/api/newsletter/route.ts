import { NextResponse } from 'next/server';
import { subscribe, unsubscribe } from '@/server/newsletter';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

// Deliberately not admin-gated and deliberately keyed off the session rather than a user
// id in the body: a subscription is the user's own, and nobody signs anybody else up.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  const { email } = (await request.json()) as { email?: string };
  const address = email?.trim() ?? '';
  if (!EMAIL.test(address)) {
    return NextResponse.json({ error: 'That does not look like an email address' }, { status: 400 });
  }

  await subscribe(session.user.id, address);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  await unsubscribe(session.user.id);
  return NextResponse.json({ ok: true });
}
