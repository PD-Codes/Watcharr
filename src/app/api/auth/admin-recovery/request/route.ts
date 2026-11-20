import { NextResponse } from 'next/server';
import { requestRecoveryCode } from '@/server/adminrecovery';
import { clientIp } from '@/server/ratelimit';
import { apiError } from '@/server/apierror';

/**
 * Where the printed link points: APP_URL only. The Origin and Host headers belong to whoever
 * sent this request — a link built from them would be a sign-in link the requester chose the
 * host of, printed where the admin is told to click it. Without APP_URL the console gets the
 * path and the code instead.
 */
function origin(): string {
  const fromEnv = process.env.APP_URL?.trim().replace(/\/+$/, '');
  return fromEnv && /^https?:\/\/[^\s/]+$/.test(fromEnv) ? fromEnv : '';
}

/** Prints a one-time admin sign-in code to the server console. Answers the same either way. */
export async function POST(request: Request) {
  const ok = await requestRecoveryCode(origin(), clientIp(request));
  if (!ok) return apiError(429, 'limited', 'err.tooManyRequests');
  return NextResponse.json({ ok: true });
}
