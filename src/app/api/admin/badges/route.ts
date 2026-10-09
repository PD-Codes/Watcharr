import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { createCustomBadge, deleteCustomBadge, updateCustomBadge } from '@/server/badges';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Creates a custom badge. Badges are deployment-wide, so only a global admin may define them. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = await readBody(request, {
    name: 'string',
    description: 'string',
    icon: 'string',
    metric: 'string',
    filter: 'string',
    filterValue: 'string',
    tiers: 'string',
  });
  if (!body) return badBody();
  const result = await createCustomBadge(body as Record<string, unknown>);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, id: result.id });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = await readBody(request, {
    id: 'number',
    name: 'string',
    description: 'string',
    icon: 'string',
    metric: 'string',
    filter: 'string',
    filterValue: 'string',
    tiers: 'string',
  });
  if (!body || typeof body.id !== 'number') return badBody();
  const result = await updateCustomBadge(body.id, body as Record<string, unknown>);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = await readBody(request, { id: 'number' });
  if (!body || typeof body.id !== 'number') return badBody();
  if (!(await deleteCustomBadge(body.id))) return NextResponse.json({ error: 'Unknown badge' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
