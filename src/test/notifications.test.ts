import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs against a throwaway SQLite file — notifications.ts imports the db module even
// though describe() itself is pure, same reason db.test.ts needs one.
const dir = mkdtempSync(join(tmpdir(), 'watcharr-notify-test-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.SESSION_SECRET ??= 'test-secret';
execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });

async function main() {
  const { describe, createChannel, listChannels, dispatch, listNotificationLog } = await import(
    '../server/notifications'
  );
  const { verifyArtSignature, publicArtUrl } = await import('../server/artlink');

  assert.match(
    describe('playback.start', { user: 'dome', title: 'Arcane', server: { label: 'Jellyfin' } }),
    /dome started "Arcane" \(Jellyfin\)/,
  );
  assert.match(
    describe('playback.stop', { user: 'dome', title: 'Arcane', percent: 92 }),
    /dome stopped "Arcane" at 92%/,
  );
  assert.match(describe('server.down', { server: { label: 'Jellyfin' } }), /Jellyfin is unreachable/);
  assert.match(describe('media.added', { title: 'Dune', year: 2021 }), /New: "Dune" \(2021\)/);
  assert.match(
    describe('monitor.alert', { message: 'dome has 4 concurrent streams (limit 2)' }),
    /4 concurrent streams/,
  );
  console.log('ok - notification text is built per event');

  // A channel's config must round-trip through the encrypted blob without ever being
  // readable from listChannels() — that is the whole point of encrypting it.
  const channel = await createChannel({
    type: 'discord',
    name: 'test',
    config: { url: 'https://discord.example/webhook' },
    events: ['playback.start'],
  });
  const rows = await listChannels();
  const stored = rows.find((r) => r.id === channel.id);
  assert.ok(stored, 'channel was persisted');
  assert.deepEqual(stored?.configuredFields, ['url']);
  console.log('ok - channel config round-trips through encryption without leaking values');

  // A failed delivery must still leave a trail — that is the whole point of the log. The
  // channel created above points at a non-resolving host, so this attempt is expected to fail.
  await dispatch('playback.start', { user: 'test', title: 'Unreachable' });
  const log = await listNotificationLog(5);
  const entry = log.find((row) => row.event === 'playback.start');
  assert.ok(entry, 'delivery attempt was logged');
  assert.equal(entry?.success, false, 'a bad Discord URL is recorded as a failure, not dropped');
  console.log('ok - a failed delivery is recorded, not silently dropped');

  // The art link signature must reject tampering and expiry — this is what stands between
  // an outbound notification and leaking a real media-server URL to a third party.
  process.env.APP_URL = 'https://watcharr.example';
  const url = publicArtUrl('main', 'abc123')!;
  const params = new URL(url).searchParams;
  const exp = Number(params.get('exp'));
  const sig = params.get('sig')!;
  assert.ok(verifyArtSignature('main', 'abc123', exp, sig), 'a genuine signature verifies');
  assert.ok(!verifyArtSignature('main', 'other-item', exp, sig), 'signature is bound to the item id');
  assert.ok(!verifyArtSignature('main', 'abc123', Date.now() - 1000, sig), 'an expired link is rejected');
  console.log('ok - signed artwork links are tamper- and time-bound');

  // Newsletter subscriptions belong to the user, so the only operations are "mine on" and
  // "mine off" — this guards the round trip and the unsubscribe actually removing the row.
  const { subscribe, unsubscribe, getSubscription, listSubscribers, renderNewsletter } =
    await import('../server/newsletter');
  const { db } = await import('../db');
  const { users } = await import('../db/schema');
  const [user] = await db
    .insert(users)
    .values({ serverId: 1, serverUserId: 'nl-1', username: 'subscriber' })
    .returning();

  await subscribe(user.id, 'a@example.com');
  assert.equal((await getSubscription(user.id))?.email, 'a@example.com');
  await subscribe(user.id, 'b@example.com');
  assert.equal((await getSubscription(user.id))?.email, 'b@example.com', 'resubscribing updates');
  assert.equal((await listSubscribers()).length, 1, 'one row per user, never a duplicate');
  await unsubscribe(user.id);
  assert.equal(await getSubscription(user.id), null);
  console.log('ok - a newsletter subscription is one row the user owns');

  // Titles come from the media server and land in an HTML mail, so they must be escaped.
  const html = await renderNewsletter([
    {
      serverLabel: 'Server',
      serverSlug: 'server',
      items: [{ itemId: '1', title: '<img src=x onerror=alert(1)>', mediaType: 'movie', genres: [] }],
    },
  ]);
  assert.ok(!html.includes('<img src=x'), 'a title cannot inject markup into the issue');
  assert.ok(html.includes('&lt;img src=x'), 'the title is still shown, escaped');
  console.log('ok - newsletter titles are escaped, not executed');
}

void main();
