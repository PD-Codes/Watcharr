import { NextResponse } from 'next/server';
import { lookupIp } from '@/server/geoip';
import { isPrivateAddress } from '@/server/net';
import { rateLimit } from '@/server/ratelimit';
import { getSession } from '@/server/session';
import { adminRequired, apiError, withApiErrors } from '@/server/apierror';

export const dynamic = 'force-dynamic';

// Only ever looks like an address. `lookupIp` normalises and validates further, but an
// obviously wrong value should not reach a third-party provider or a DNS resolver at all.
const LOOKS_LIKE_IP = /^[0-9a-fA-F.:%[\]]{2,64}$/;

/** Details behind an address, for the IP dialog. Admin only: this is viewer data. */
export const GET = withApiErrors(async (request: Request) => {
  const session = await getSession();
  if (!session || !(session.user.isAdmin || session.user.globalAdmin)) return adminRequired();

  const ip = new URL(request.url).searchParams.get('ip') ?? '';
  if (!LOOKS_LIKE_IP.test(ip)) {
    return apiError(400, 'invalid-address', 'err.invalidAddress');
  }
  // An outbound request per click, so a page full of addresses cannot be used to hammer
  // the provider. Cached results never reach this limit in practice.
  if (!rateLimit(`iplookup:${session.user.id}`, 60, 60_000)) {
    return apiError(429, 'limited', 'err.tooManyLookups');
  }

  // A refresh skips the cached row. Turning the country lookup on does not expire what was
  // stored while it was off, and that entry is valid for a month — so the dialog needs a
  // way to ask again. Same rate limit as any other lookup.
  const details = await lookupIp(ip, new URL(request.url).searchParams.has('refresh'));
  return NextResponse.json({ ...details, isLocal: isPrivateAddress(ip) });
});
