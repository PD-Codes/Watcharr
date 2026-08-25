import { NextResponse } from 'next/server';
import { sendTest } from '@/server/notifications';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const { id } = (await request.json()) as { id?: number | 'webhook' };
  if (id === undefined) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const result = await sendTest(id);
  return NextResponse.json(result.ok ? { ok: true } : { error: result.error ?? 'Delivery failed' });
}
