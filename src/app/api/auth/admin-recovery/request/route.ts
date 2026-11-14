import { NextResponse } from 'next/server';
import { requestRecoveryCode } from '@/server/adminrecovery';
import { clientIp } from '@/server/ratelimit';
import { acceptedHosts } from '@/server/sameorigin';

/** Where the printed link points: APP_URL, else the address the browser used, else a bare path. */
function origin(request: Request): string {
  const fromEnv = process.env.APP_URL?.trim().replace(/\/+$/, '');
  if (fromEnv && /^https?:\/\/[^\s/]+$/.test(fromEnv)) return fromEnv;
  const header = request.headers.get('origin');
  try {
    if (header && acceptedHosts(request.headers).includes(new URL(header).host.toLowerCase())) return header;
  } catch {
    // not a URL
  }
  return '';
}

/** Prints a one-time admin sign-in code to the server console. Answers the same either way. */
export async function POST(request: Request) {
  const ok = await requestRecoveryCode(origin(request), clientIp(request));
  if (!ok) return NextResponse.json({ error: 'Too many requests', code: 'limited' }, { status: 429 });
  return NextResponse.json({ ok: true });
}
