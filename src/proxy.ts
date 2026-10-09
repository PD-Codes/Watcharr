import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isCrossSiteWrite } from '@/server/sameorigin';

// Next 16's name for what used to be middleware.ts. The one place that refuses a write
// to the API when a page on another site started it; no route needs an exemption.
export function proxy(request: NextRequest) {
  if (isCrossSiteWrite(request.method, request.headers)) {
    return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
