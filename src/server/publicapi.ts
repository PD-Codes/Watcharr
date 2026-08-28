import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSettings } from './config';

/**
 * Authentication for the read-only HTTP API under /api/v1.
 *
 * Everything else in this app is reached with a session cookie, which is exactly what a
 * dashboard, a Grafana scrape or a shell script cannot produce. Tautulli's API key is the
 * reason half its ecosystem exists; this is the same idea with the smallest possible
 * surface — one key, read-only, deployment-wide, off until an admin issues one.
 *
 * ponytail: one key rather than per-user keys with scopes. The endpoints expose what a
 * server admin already sees, so a second permission model would guard nothing new. Split
 * it when somebody wants to hand a key to a person rather than to a dashboard.
 */

/**
 * Constant-time compare. Both sides are hashed first because timingSafeEqual throws on a
 * length mismatch — comparing lengths beforehand would leak the key's length, and a digest
 * is always the same size.
 */
function sameKey(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Returns a 401/403 response when the request may not use the API, or null when it may.
 * The key is accepted in a header or a query parameter: some dashboards can only be given
 * a URL, and a self-hosted deployment is where that trade-off is the admin's to make.
 */
export async function checkApiKey(request: Request): Promise<NextResponse | null> {
  const { apiKey } = await getSettings();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'The API is disabled. Generate a key under Settings.' },
      { status: 403 },
    );
  }
  const url = new URL(request.url);
  const provided = request.headers.get('x-api-key') ?? url.searchParams.get('apikey') ?? '';
  if (!provided || !sameKey(provided, apiKey)) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  return null;
}

/** Clamps a ?days= parameter. Anything unparseable falls back rather than erroring out. */
export function daysParam(request: Request, fallback = 30): number {
  const raw = Number(new URL(request.url).searchParams.get('days'));
  return Number.isFinite(raw) && raw > 0 ? Math.min(3650, Math.round(raw)) : fallback;
}
