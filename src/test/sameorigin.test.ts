import assert from 'node:assert/strict';
import { isCrossSiteWrite } from '../server/sameorigin';

const req = (method: string, headers: Record<string, string>, appUrl?: string) =>
  isCrossSiteWrite(method, new Headers(headers), appUrl);

// Reads are never refused, whatever they claim to be.
assert.equal(req('GET', { 'sec-fetch-site': 'cross-site' }), false);

// Browsers that send Sec-Fetch-Site: only the same origin (or a direct visit) may write.
assert.equal(req('POST', { 'sec-fetch-site': 'same-origin' }), false);
assert.equal(req('POST', { 'sec-fetch-site': 'none' }), false);
assert.equal(req('POST', { 'sec-fetch-site': 'cross-site' }), true);
assert.equal(req('DELETE', { 'sec-fetch-site': 'same-site' }), true, 'a sibling subdomain is another origin');
assert.equal(
  req('POST', { 'sec-fetch-site': 'same-origin', origin: 'https://evil.test', host: 'watch.test' }),
  false,
  'Sec-Fetch-Site decides when it is there, so a proxy that rewrites Host cannot lock people out',
);

// No header at all: a script or curl, not a page in a browser.
assert.equal(req('POST', {}), false);

// Older browsers: Origin against the Host that was asked for.
assert.equal(req('POST', { origin: 'https://watch.test', host: 'watch.test' }), false);
assert.equal(req('PATCH', { origin: 'https://WATCH.test', host: 'watch.test' }), false);
assert.equal(req('POST', { origin: 'https://evil.test', host: 'watch.test' }), true);
assert.equal(req('POST', { origin: 'null', host: 'watch.test' }), true);
assert.equal(req('POST', { origin: 'https://watch.test', host: 'app:3000', 'x-forwarded-host': 'watch.test' }), false);
assert.equal(req('POST', { origin: 'https://watch.test', host: 'app:3000' }, 'https://watch.test'), false);
assert.equal(req('POST', { origin: 'https://evil.test', host: 'app:3000' }, 'https://watch.test'), true);
assert.equal(req('POST', { origin: 'https://evil.test', host: 'a.test' }, 'not a url'), true, 'a broken APP_URL vouches for nothing');

console.log('ok - cross-site writes are refused, same-origin and non-browser ones pass');
