import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isCrossSiteWrite } from '@/server/sameorigin';

// The admin "view as" cookie (VIEW_AS_COOKIE in server/session.ts). Presence is enough here:
// a forged cookie can only make the forger's own writes fail.
const VIEW_AS = 'watcharr_view_as';
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);
// The way out of the preview, and signing out altogether, stay possible.
const PREVIEW_EXEMPT = new Set(['/api/admin/view-as', '/api/auth/logout']);

// Next 16's name for what used to be middleware.ts. The one place that refuses a write
// to the API when a page on another site started it, or while an admin is only previewing;
// no route needs an exemption.
export function proxy(request: NextRequest) {
  if (isCrossSiteWrite(request.method, request.headers)) {
    return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  }
  if (
    request.cookies.has(VIEW_AS) &&
    !READ_ONLY.has(request.method) &&
    !PREVIEW_EXEMPT.has(request.nextUrl.pathname)
  ) {
    return NextResponse.json({ error: 'Read-only while previewing another user' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
