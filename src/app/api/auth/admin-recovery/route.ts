import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { redeemRecoveryCode } from '@/server/adminrecovery';
import { clientIp } from '@/server/ratelimit';

/** Signs in as the global admin with the one-time code from the server console. */
export async function POST(request: Request) {
  const body = await readBody(request, { code: 'string' });
  if (!body?.code) return badBody();
  const ip = clientIp(request);
  const result = await redeemRecoveryCode(body.code, { ip, userAgent: request.headers.get('user-agent') ?? undefined });
  if (result === 'ok') return NextResponse.json({ ok: true });
  if (result === 'no-server') return NextResponse.json({ error: 'No media server configured', code: result }, { status: 409 });
  return NextResponse.json(
    { error: result === 'limited' ? 'Too many attempts' : 'Invalid code', code: result },
    { status: result === 'limited' ? 429 : 401 },
  );
}
