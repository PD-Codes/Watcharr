import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { getSession, setGlobalAdmin } from '@/server/session';
import { apiError, badBody, globalAdminRequired } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/** Grants or revokes the deployment-wide admin role. Only a global admin may do this. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) return globalAdminRequired();

  const body = await readBody(request, { userId: 'number', globalAdmin: 'boolean' });
  if (!body) return badBody();
  const { userId, globalAdmin } = body;
  if (!userId || typeof globalAdmin !== 'boolean') {
    return apiError(400, 'missing-fields', 'err.roleFieldsRequired');
  }

  // Removing the last global admin would leave nobody able to manage servers or hand the
  // role back out — the deployment would be locked into its current shape. The check is part
  // of the UPDATE (setGlobalAdmin), so two concurrent revocations cannot both pass it.
  const result = await setGlobalAdmin(userId, globalAdmin);
  if (result === 'unknown') return apiError(404, 'user-not-found', 'err.userNotFound');
  if (result === 'last-admin') {
    return apiError(400, 'last-admin', 'err.lastGlobalAdmin');
  }
  return NextResponse.json({ ok: true });
}
