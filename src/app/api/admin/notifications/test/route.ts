import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { sendTest } from '@/server/notifications';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  // `id` is a channel number or the string "webhook", which no single field kind expresses.
  const body = (await readBody(request, {})) as { id?: unknown } | null;
  if (!body) return badBody();
  const id = body.id;
  if (id === undefined) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  if (typeof id !== 'number' && id !== 'webhook') return badBody();

  const result = await sendTest(id);
  return NextResponse.json(result.ok ? { ok: true } : { error: result.error ?? 'Delivery failed' });
}
