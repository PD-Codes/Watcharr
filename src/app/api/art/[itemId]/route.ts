import { createAdapter, type ServerType } from '@/server/adapters';
import { getConfig } from '@/server/config';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

// Item ids are opaque handles from the media server: Plex rating keys are numeric,
// Jellyfin/Emby ids are hex GUIDs. Nothing legitimate contains a dot, slash or percent,
// so rejecting them stops the id from steering the upstream URL somewhere else.
const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;

const UPSTREAM_TIMEOUT_MS = 10_000;

/** Proxies artwork so media server tokens never reach the browser. */
export async function GET(_request: Request, context: { params: Promise<{ itemId: string }> }) {
  if (!(await getSession())) return new Response('Unauthorized', { status: 401 });

  const { itemId } = await context.params;
  if (!ITEM_ID.test(itemId)) return new Response('Bad request', { status: 400 });

  const cfg = await getConfig();
  if (!cfg) return new Response('Not configured', { status: 409 });

  const adapter = createAdapter(cfg.serverType as ServerType, cfg.serverUrl, cfg.serverToken);
  // Defence in depth: even if an adapter builds the URL badly, only the configured
  // media server may be reached — never another host on the internal network.
  let target: URL;
  try {
    target = new URL(adapter.posterUrl(itemId));
    if (target.origin !== new URL(cfg.serverUrl).origin) {
      return new Response('Bad request', { status: 400 });
    }
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const upstream = await fetch(target, {
    cache: 'no-store',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => null);
  if (!upstream?.ok || !upstream.body) return new Response('Not found', { status: 404 });

  // Only ever hand the browser an image. Passing the upstream content type through
  // verbatim would let a non-image response render as HTML on this app's origin.
  const contentType = upstream.headers.get('Content-Type') ?? '';
  if (!contentType.startsWith('image/')) return new Response('Not found', { status: 404 });

  return new Response(upstream.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
