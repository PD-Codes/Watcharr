import assert from 'node:assert/strict';
import { clearRateLimit, clientIp, isRateLimited, rateLimit } from '../server/ratelimit';

// Counting, reading without counting, and clearing.
assert.ok(rateLimit('a', 2, 60_000));
assert.ok(rateLimit('a', 2, 60_000));
assert.ok(!rateLimit('a', 2, 60_000), 'the third hit is over the limit');
assert.ok(isRateLimited('a', 2));
assert.ok(!isRateLimited('never-seen', 2));
clearRateLimit('a');
assert.ok(!isRateLimited('a', 2), 'a cleared counter starts over');

// A window that has passed no longer counts.
const realNow = Date.now;
rateLimit('b', 1, 1_000);
assert.ok(isRateLimited('b', 1));
Date.now = () => realNow() + 2_000;
assert.ok(!isRateLimited('b', 1), 'an expired counter is not a limit');
assert.ok(rateLimit('b', 1, 1_000), 'and the next hit opens a new window');
Date.now = realNow;

// The map is bounded: with keys made up by clients, the stalest counters go first and one
// that is still being hit survives the cap.
rateLimit('stale', 1, 3_600_000);
rateLimit('hot', 1, 3_600_000);
for (let i = 0; i < 10_050; i += 1) {
  rateLimit(`flood-${i}`, 1, 3_600_000);
  if (i % 1_000 === 0) rateLimit('hot', 1, 3_600_000);
}
rateLimit('trigger', 1, 3_600_000);
assert.ok(!isRateLimited('stale', 1), 'the least recently used counter was evicted');
assert.ok(isRateLimited('hot', 1), 'a counter that keeps being hit stays');

console.log('ok - rate limit counters are bounded and expire');

// The client writes the start of X-Forwarded-For, the reverse proxy appends the real address:
// only the proxy's entry may count, or one made-up value per request beats every limit.
{
  const req = (xff?: string, real?: string) =>
    new Request('http://app/', { headers: { ...(xff ? { 'x-forwarded-for': xff } : {}), ...(real ? { 'x-real-ip': real } : {}) } });
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.9')), '203.0.113.9', 'the entry our proxy added');
  assert.equal(clientIp(req('6.6.6.6, 198.51.100.1, 203.0.113.9'), 2), '198.51.100.1', 'two trusted proxies');
  assert.equal(clientIp(req('203.0.113.9'), 5), '203.0.113.9', 'more hops than entries: the first one');
  assert.equal(clientIp(req(undefined, '10.0.0.2')), '10.0.0.2');
  assert.equal(clientIp(req()), 'unknown');
  assert.equal(clientIp(req('2001:db8::1')), '2001:db8::1', 'IPv6 is an address too');
  // Without a reverse proxy the header is the client's own text: anything that is not an
  // address would be a fresh rate-limit bucket and lands in logs verbatim.
  assert.equal(clientIp(req('not-an-ip')), 'unknown');
  assert.equal(clientIp(req('203.0.113.9, evil')), 'unknown');
  // A proxy that appends the endpoint: the port goes, the address stays.
  assert.equal(clientIp(req('203.0.113.9:4711')), '203.0.113.9', 'a port is not part of the address');
  assert.equal(clientIp(req('6.6.6.6, [::1]:443')), '::1', 'bracketed IPv6 with a port');
  assert.equal(clientIp(req('[2001:db8::7]')), '2001:db8::7', 'bracketed IPv6 without a port');
  assert.equal(clientIp(req(undefined, '10.0.0.2:80')), '10.0.0.2', 'X-Real-IP with a port');
  assert.equal(clientIp(req('2001:db8::1:443')), '2001:db8::1:443', 'a bare IPv6 address keeps its last group');
  assert.equal(clientIp(req('[evil]:443')), 'unknown', 'brackets around something that is no address');
  assert.equal(clientIp(req('999.1.1.1:80')), 'unknown');
  assert.equal(clientIp(req(undefined, '<script>')), 'unknown');
  assert.equal(clientIp(req('999.1.1.1')), 'unknown');
  console.log('ok - the client address comes from our own proxy, not from the client');
}
