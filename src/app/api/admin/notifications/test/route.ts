import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { sendTest } from '@/server/notifications';
import { getSession } from '@/server/session';
import { apiError, badBody, globalAdminRequired, withApiErrors } from '@/server/apierror';

export const dynamic = 'force-dynamic';

export const POST = withApiErrors(async (request: Request) => {
  const session = await getSession();
  if (!session?.user.globalAdmin) return globalAdminRequired();

  // `id` is a channel number or the string "webhook", which no single field kind expresses.
  const body = (await readBody(request, {})) as { id?: unknown } | null;
  if (!body) return badBody();
  const id = body.id;
  if (id === undefined) return apiError(400, 'id-required', 'err.idRequired');
  if (typeof id !== 'number' && id !== 'webhook') return badBody();

  const result = await sendTest(id);
  // 200 either way, as before: the request worked, the channel did not.
  return result.ok
    ? NextResponse.json({ ok: true })
    : apiError(200, 'delivery-failed', 'err.deliveryFailed', { message: result.error });
});
