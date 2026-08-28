import { NextResponse } from 'next/server';
import { rotateApiKey, updateSettings } from '@/server/config';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Issues a new read-only API key and returns it once, in clear text. There is no endpoint
 * that reads an existing key back: it is stored encrypted like every other secret here, so
 * losing it means issuing another one rather than looking it up.
 */
export async function POST() {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  return NextResponse.json({ key: await rotateApiKey() });
}

/** Turns the API off again. Every dashboard configured with the old key stops working. */
export async function DELETE() {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  await updateSettings({ apiKey: null });
  return NextResponse.json({ ok: true });
}
