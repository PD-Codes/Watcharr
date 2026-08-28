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
  const { translator } = await import('../i18n');
  const en = translator('en-US');

  assert.match(
    describe(en, 'playback.start', { user: 'dome', title: 'Arcane', server: { label: 'Jellyfin' } }),
    /dome started "Arcane" \(Jellyfin\)/,
  );
  assert.match(
    describe(en, 'playback.stop', { user: 'dome', title: 'Arcane', percent: 92 }),
    /dome stopped "Arcane" at 92%/,
  );
  assert.match(describe(en, 'server.down', { server: { label: 'Jellyfin' } }), /Jellyfin is unreachable/);
  assert.match(describe(en, 'media.added', { title: 'Dune', year: 2021 }), /New: "Dune" \(2021\)/);
  assert.match(
    describe(en, 'monitor.alert', { message: 'dome has 4 concurrent streams (limit 2)' }),
    /4 concurrent streams/,
  );
  console.log('ok - notification text is built per event');

  // The line a channel receives follows the configured language. Without this the app
  // could be entirely German while every Discord message stayed English.
  const de = translator('de-DE');
  const german = describe(de, 'playback.start', { user: 'dome', title: 'Arcane' });
  assert.ok(german.includes('gestartet') && !german.includes('started'), german);
  console.log('ok - notification text follows the configured language');

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

  // Conditions decide whether somebody's phone lights up at two in the morning, so the
  // three cases that matter are: unset never filters, a set one that the event can answer
  // filters, and a set one the event cannot answer lets it through instead of eating it.
  const { matchesConditions, renderTemplate } = await import('../server/features');
  assert.ok(matchesConditions({}, { user: 'dome' }), 'no conditions means everything passes');
  assert.ok(matchesConditions(null, { user: 'dome' }), 'a channel from before conditions existed');
  assert.ok(matchesConditions({ users: ['dome'] }, { user: 'dome' }));
  assert.ok(!matchesConditions({ users: ['someone'] }, { user: 'dome' }));
  assert.ok(!matchesConditions({ mediaTypes: ['movie'] }, { mediaType: 'episode' }));
  assert.ok(!matchesConditions({ transcodeOnly: true }, { transcoding: false }));
  assert.ok(
    matchesConditions({ transcodeOnly: true }, { message: 'bandwidth' }),
    'an event that reports no transcode flag is not filtered by one',
  );
  assert.ok(
    matchesConditions({ users: ['dome'] }, { message: 'server down' }),
    'an event with no user is not filtered by a user condition',
  );
  assert.ok(matchesConditions({ libraries: ['1:movies'] }, { sectionKey: '1:movies' }));
  assert.ok(!matchesConditions({ libraries: ['1:movies'] }, { sectionKey: '1:shows' }));
  assert.ok(
    !matchesConditions({ libraries: ['1:movies'] }, { sectionKey: '2:movies' }),
    'a section id is only unique within its server, so the key carries the server',
  );
  assert.ok(
    matchesConditions({ libraries: ['1:movies'] }, { title: 'Just added' }),
    'an event whose library could not be resolved is not dropped',
  );
  console.log('ok - channel conditions filter what they can answer and nothing else');

  assert.equal(
    renderTemplate('{user} started {title} on {server}', {
      user: 'dome',
      title: 'Arcane',
      server: { label: 'Jellyfin' },
    }),
    'dome started Arcane on Jellyfin',
  );
  assert.equal(
    renderTemplate('{user} watched {nonexistent}', { user: 'dome' }),
    'dome watched',
    'an unknown placeholder renders as nothing, never as its own name',
  );
  console.log('ok - message templates substitute payload fields');

  // The script channel is the only place an admin-supplied string becomes an executable
  // path, so the rejections are the test — anything that is not a plain file name must not
  // reach execFile at all.
  const { sendTest: runChannel } = await import('../server/notifications');
  for (const command of ['../../bin/sh', '/bin/sh', 'sub/dir.sh', '.env', '']) {
    const { id } = await createChannel({
      type: 'script',
      name: 'script',
      config: { command },
      events: [],
    });
    const result = await runChannel(id);
    assert.equal(result.ok, false, `"${command}" must be rejected before it is executed`);
    assert.match(String(result.error), /plain file name|scripts folder/);
  }
  console.log('ok - a script channel only accepts a plain file name');

  // The library filter stands or falls on this lookup: no media server event names a
  // library, so a film is matched by its own id and an episode by its series title.
  const { buildSectionIndex, lookupSection } = await import('../server/library');
  const index = buildSectionIndex(1, [
    { itemId: 'm-1', title: 'Blade Runner', mediaType: 'movie', genres: [], sectionId: 'movies' },
    { itemId: 's-1', title: 'Firefly', mediaType: 'show', genres: [], sectionId: 'shows' },
    // No section id: a backend that does not report one must not land in the index at all.
    { itemId: 'x-1', title: 'Orphan', mediaType: 'movie', genres: [] },
  ]);

  assert.equal(lookupSection(index, { itemId: 'm-1', title: 'Blade Runner' }), '1:movies');
  assert.equal(
    lookupSection(index, { itemId: 'ep-14', title: 'Serenity', grandparentTitle: 'Firefly' }),
    '1:shows',
    'an episode id is unknown, so its series name is what places it',
  );
  assert.equal(
    lookupSection(index, { itemId: 'ep-14', title: 'Firefly', grandparentTitle: null }),
    '1:shows',
    'a title-only match still works when there is no series name',
  );
  assert.equal(lookupSection(index, { itemId: 'x-1', title: 'Orphan' }), null);
  assert.equal(lookupSection(index, { itemId: 'never-seen', title: 'Just added' }), null);
  console.log('ok - an item resolves to its library without asking the media server');
}

void main();
