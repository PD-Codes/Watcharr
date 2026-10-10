import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isCrossSiteWrite } from '@/server/sameorigin';

// The admin "view as" cookie (VIEW_AS_COOKIE in server/session.ts) and the session cookie
// (COOKIE there). The signature is not checked here: a forged cookie can only make the
// forger's own writes fail.
const VIEW_AS = 'watcharr_view_as';
const SESSION = 'watcharr_session';
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
  const viewAs = request.cookies.get(VIEW_AS)?.value;
  if (!viewAs) return NextResponse.next();
  // The preview is bound to one sign-in ("<session id>:<user id>.<hmac>", the session cookie is
  // "<session id>.<hmac>"). A leftover from an earlier sign-in — a new login without signing
  // out, an expired session — previews nothing (getSession ignores it), so it must not lock
  // every write either: that read as "my settings do not save", with no banner to explain it.
  const sessionId = request.cookies.get(SESSION)?.value?.split('.')[0];
  if (!sessionId || viewAs.split(':')[0] !== sessionId) {
    const response = NextResponse.next();
    response.cookies.delete(VIEW_AS);
    return response;
  }
  if (!READ_ONLY.has(request.method) && !PREVIEW_EXEMPT.has(request.nextUrl.pathname)) {
    return NextResponse.json({ error: 'Read-only while previewing another user' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
