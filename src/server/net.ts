// No 'server-only': this is pure address arithmetic and is unit tested directly.

/**
 * Whether an address belongs to the local network rather than the public internet.
 *
 * This is the half of Tautulli's geo display that is actually used day to day — "is this
 * person streaming from home or from outside" — and it needs no database, no API key and
 * no outbound request. Country lookup is the optional part, see server/geoip.ts.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = normalise(address);
  if (!ip) return false;

  if (ip.includes(':')) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

/** Strips a port, brackets and the IPv4-mapped IPv6 prefix. Returns '' if unusable. */
export function normalise(address: string): string {
  let ip = address.trim();
  if (!ip) return '';

  // "[::1]:8096"
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  // "192.168.1.5:47204" — only strip the port when it cannot be part of an IPv6 address.
  else if (ip.split(':').length === 2 && ip.includes('.')) ip = ip.split(':')[0];

  ip = ip.toLowerCase().replace(/%.*$/, ''); // drop a zone index like %eth0
  // ::ffff:192.168.1.5 is an IPv4 address wearing an IPv6 hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  return mapped ? mapped[1] : ip;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((p) => Number.parseInt(p, 10));
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;

  if (a === 10 || a === 127) return true; // private, loopback
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  if (ip === '::1' || ip === '::') return true;
  const head = Number.parseInt(ip.split(':')[0] || '0', 16);
  if (Number.isNaN(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  return false;
}
