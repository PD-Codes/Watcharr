import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { createCustomBadge, deleteCustomBadge, updateCustomBadge } from '@/server/badges';
import { getSession } from '@/server/session';
import { apiError, badBody, globalAdminRequired } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/** Creates a custom badge. Badges are deployment-wide, so only a global admin may define them. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) return globalAdminRequired();
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
  if (!result.ok) return apiError(400, 'invalid-badge', 'err.actionFailed', { message: result.error });
  return NextResponse.json({ ok: true, id: result.id });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) return globalAdminRequired();
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
  if (!result.ok) return apiError(result.status, 'invalid-badge', 'err.actionFailed', { message: result.error });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) return globalAdminRequired();
  const body = await readBody(request, { id: 'number' });
  if (!body || typeof body.id !== 'number') return badBody();
  if (!(await deleteCustomBadge(body.id))) return apiError(404, 'badge-not-found', 'err.badgeNotFound');
  return NextResponse.json({ ok: true });
}
