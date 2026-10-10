import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { escapeHtml } from './newsletter-html';
import { sendMail } from './notifications';
import { acceptedHosts } from './sameorigin';

// Mails go out through the deployment's SMTP account, so an address that is not the account's
// own is confirmed first: otherwise anyone could sign a stranger up for the newsletter (library
// contents and viewing figures) or event mails. Stateless: the link carries everything, signed.

export type MailKind = 'newsletter' | 'notify';
const TTL_MS = 48 * 60 * 60 * 1000;

function mac(payload: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return createHmac('sha256', `${secret}:mail-confirm`).update(payload).digest('hex');
}

const payloadOf = (userId: number, address: string, kind: MailKind, exp: number) =>
  `${userId}|${address.toLowerCase()}|${kind}|${exp}`;

/** True when the address is the account's own (as the media server reports it). */
export function isOwnAddress(accountEmail: string | null | undefined, address: string): boolean {
  return !!accountEmail && accountEmail.trim().toLowerCase() === address.trim().toLowerCase();
}

export function confirmationQuery(userId: number, address: string, kind: MailKind, now = Date.now()): string {
  const exp = now + TTL_MS;
  const params = new URLSearchParams({ u: String(userId), a: address, k: kind, e: String(exp) });
  params.set('s', mac(payloadOf(userId, address, kind, exp)));
  return params.toString();
}

/** The confirmed request, or null for a forged, altered or expired link. */
export function readConfirmation(
  params: URLSearchParams,
  now = Date.now(),
): { userId: number; address: string; kind: MailKind } | null {
  const userId = Number(params.get('u'));
  const address = params.get('a') ?? '';
  const kind = params.get('k');
  const exp = Number(params.get('e'));
  const sig = params.get('s') ?? '';
  if (!Number.isInteger(userId) || !address || (kind !== 'newsletter' && kind !== 'notify')) return null;
  if (!Number.isFinite(exp) || exp < now) return null;
  const expected = Buffer.from(mac(payloadOf(userId, address, kind, exp)), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { userId, address, kind };
}

/** Where the link points: APP_URL, or the address this request came in on. */
function baseUrl(request: Request): string | null {
  const fromEnv = process.env.APP_URL?.trim().replace(/\/$/, '');
  if (fromEnv && /^https?:\/\/[^\s/]+$/.test(fromEnv)) return fromEnv;
  const origin = request.headers.get('origin');
  try {
    if (origin && acceptedHosts(request.headers).includes(new URL(origin).host.toLowerCase())) return origin;
  } catch {
    // not a URL
  }
  return null;
}

export async function sendConfirmation(
  request: Request,
  userId: number,
  address: string,
  kind: MailKind,
  text: { subject: string; body: string; button: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = baseUrl(request);
  if (!base) return { ok: false, error: 'APP_URL is not set, so no confirmation link can be sent' };
  const link = `${base}/api/mail/confirm?${confirmationQuery(userId, address, kind)}`;
  const html = `<p>${escapeHtml(text.body)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(text.button)}</a></p>`;
  const sent = await sendMail([address], text.subject, html);
  return sent.ok ? { ok: true } : { ok: false, error: sent.error ?? 'The confirmation mail could not be sent' };
}
