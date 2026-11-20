import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { redeemRecoveryCode } from '@/server/adminrecovery';
import { clientIp } from '@/server/ratelimit';
import { apiError, badBody } from '@/server/apierror';

/** Signs in as the global admin with the one-time code from the server console. */
export async function POST(request: Request) {
  const body = await readBody(request, { code: 'string' });
  if (!body?.code) return badBody();
  const ip = clientIp(request);
  const result = await redeemRecoveryCode(body.code, { ip, userAgent: request.headers.get('user-agent') ?? undefined });
  if (result === 'ok') return NextResponse.json({ ok: true });
  if (result === 'no-server') return apiError(409, result, 'err.noServerConfigured');
  return result === 'limited'
    ? apiError(429, result, 'err.limited')
    : apiError(401, result, 'err.invalidCode');
}
