import 'server-only';
import { hmacSign, hmacVerify } from './crypto';

// A signed, time-boxed alternative to the session-cookie check on the artwork proxy. An
// outbound notification has no browser session, and the real media server URL cannot be
// handed to Discord/Slack directly — Plex embeds the admin token in it, which is exactly
// the leak the proxy exists to prevent (see the itemId note in CLAUDE.md). This gives a
// third party a URL that only ever resolves one image, for a limited time, and nothing else.

const TTL_MS = 24 * 60 * 60 * 1000;

const payload = (serverSlug: string, itemId: string, exp: number) => `${serverSlug}:${itemId}:${exp}`;

export function verifyArtSignature(
  serverSlug: string,
  itemId: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  // Links signed before keys were split still verify until they expire (24 hours).
  return hmacVerify('art-link', payload(serverSlug, itemId, exp), sig);
}

/** Publicly fetchable artwork URL for outbound notifications, or null if APP_URL is unset. */
export function publicArtUrl(serverSlug: string, itemId: string): string | null {
  const base = process.env.APP_URL?.trim();
  if (!base) return null;
  const exp = Date.now() + TTL_MS;
  const sig = hmacSign('art-link', payload(serverSlug, itemId, exp));
  return `${base.replace(/\/$/, '')}/api/art/${serverSlug}/${itemId}?exp=${exp}&sig=${sig}`;
}
