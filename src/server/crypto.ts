import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Media server tokens are as good as passwords, so they are encrypted at rest.
// Every key is derived from SESSION_SECRET; rotating that secret invalidates stored tokens.
//
// Each use gets its own subkey (HKDF-SHA256, one `info` per purpose), so a value signed for
// one purpose can never be replayed as another, and a weakness in how one key is used does
// not spill into the others. Before this, the raw secret signed cookies, PIN bindings,
// previews and artwork links alike, and its SHA-256 was the AES key. Those legacy keys are
// still accepted when checking or decrypting — a release must not sign anyone out or make a
// stored token unreadable — but nothing new is ever produced with them.

export type KeyPurpose = 'session-cookie' | 'plex-pin' | 'quick-connect' | 'view-as' | 'art-link' | 'aes-256-gcm';

const SALT = 'watcharr';

function rootSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

/** The 32-byte subkey for one purpose. Cheap enough (microseconds) not to need a cache. */
export function deriveKey(purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', rootSecret(), SALT, `watcharr/${purpose}/v1`, 32));
}

/** Hex HMAC-SHA256 of `data` under the purpose's own key. */
export function hmacSign(purpose: KeyPurpose, data: string): string {
  return createHmac('sha256', deriveKey(purpose)).update(data).digest('hex');
}

function sameHex(expectedHex: string, givenHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(givenHex, 'hex');
  return expected.length > 0 && expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Checks a hex HMAC against the purpose's key and, failing that, against the raw secret that
 * signed everything before keys were split. The fallback only keeps values issued by an older
 * release valid (session cookies live up to 30 days, artwork links 24 hours); it can be dropped
 * once no such value can still be around.
 */
export function hmacVerify(purpose: KeyPurpose, data: string, macHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(macHex)) return false;
  if (sameHex(hmacSign(purpose, data), macHex)) return true;
  // Removable no earlier than 30 days after the release that introduced the derived keys: the
  // longest-lived value signed the old way is a 30-day session cookie.
  return sameHex(createHmac('sha256', rootSecret()).update(data).digest('hex'), macHex);
}

// v1: AES-256-GCM under sha256(SESSION_SECRET). v2: the same cipher under the HKDF subkey.
// The prefix says which key to use, so decrypting never has to guess.
const LEGACY_PREFIX = 'v1:';
const PREFIX = 'v2:';

function legacyAesKey(): Buffer {
  return createHash('sha256').update(rootSecret()).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey('aes-256-gcm'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
}

export function decryptSecret(stored: string): string {
  let key: Buffer;
  let body: string;
  if (stored.startsWith(PREFIX)) {
    key = deriveKey('aes-256-gcm');
    body = stored.slice(PREFIX.length);
  } else if (stored.startsWith(LEGACY_PREFIX)) {
    // Written before keys were split. Stays readable for good: rewriting every stored token
    // on start-up would be a migration of its own, and a backup restored later carries v1 too.
    key = legacyAesKey();
    body = stored.slice(LEGACY_PREFIX.length);
  } else {
    return stored; // value written before encryption existed
  }
  const [iv, tag, data] = body.split(':').map((p) => Buffer.from(p, 'base64'));
  // Pinned: without it Node accepts a truncated tag, which weakens what GCM guarantees.
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
