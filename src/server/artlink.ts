import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// A signed, time-boxed alternative to the session-cookie check on the artwork proxy. An
// outbound notification has no browser session, and the real media server URL cannot be
// handed to Discord/Slack directly — Plex embeds the admin token in it, which is exactly
// the leak the proxy exists to prevent (see the itemId note in CLAUDE.md). This gives a
// third party a URL that only ever resolves one image, for a limited time, and nothing else.

const TTL_MS = 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

function sign(serverSlug: string, itemId: string, exp: number): string {
  return createHmac('sha256', secret()).update(`${serverSlug}:${itemId}:${exp}`).digest('hex');
}

export function verifyArtSignature(
  serverSlug: string,
  itemId: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = Buffer.from(sign(serverSlug, itemId, exp), 'hex');
    given = Buffer.from(sig, 'hex');
  } catch {
    return false;
  }
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Publicly fetchable artwork URL for outbound notifications, or null if APP_URL is unset. */
export function publicArtUrl(serverSlug: string, itemId: string): string | null {
  const base = process.env.APP_URL?.trim();
  if (!base) return null;
  const exp = Date.now() + TTL_MS;
  const sig = sign(serverSlug, itemId, exp);
  return `${base.replace(/\/$/, '')}/api/art/${serverSlug}/${itemId}?exp=${exp}&sig=${sig}`;
}
