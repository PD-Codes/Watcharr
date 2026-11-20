import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Library visibility (library.ts): who may see which sections. The rules are pure apart from the
// clock and the loader, both injected here; library.ts still opens the database on import, so
// the suite brings a throwaway file of its own rather than touching ./data.
const dir = mkdtempSync(join(tmpdir(), 'watcharr-visibility-test-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.SESSION_SECRET ??= 'test-secret';
execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  const { accessOf, canSeeSection, filterVisible, resolveAccess, userSectionAccess, ALL_SECTIONS, NO_SECTIONS } =
    await import('../server/library');
  type Entry = { ids: string[] | null; at: number };

  const items = [
    { itemId: 'm1', sectionId: 'movies' },
    { itemId: 's1', sectionId: 'shows' },
    { itemId: 'k1', sectionId: 'kids' },
    { itemId: 'x1' }, // a listing without library ids (a "mixed" Jellyfin server)
  ];

  // Admins see everything, whatever the media server would answer for them.
  assert.deepEqual(accessOf({ isAdmin: true, globalAdmin: false }, []), ALL_SECTIONS);
  assert.deepEqual(accessOf({ isAdmin: false, globalAdmin: true }, null), ALL_SECTIONS);
  assert.equal(filterVisible(items, ALL_SECTIONS).length, 4, 'an admin sees every item, sectionless ones too');
  let loads = 0;
  const admin = await userSectionAccess({ id: 1, serverId: 1, serverUserId: 'a', isAdmin: true, globalAdmin: false });
  assert.equal(admin.all, true, 'an admin is never looked up');
  assert.equal(loads, 0);
  console.log('ok - admins see every library');

  // Everybody else sees the subset the server names, and nothing without a library id.
  const some = accessOf({ isAdmin: false, globalAdmin: false }, ['movies', 'shows']);
  assert.deepEqual(filterVisible(items, some).map((i) => i.itemId), ['m1', 's1']);
  assert.equal(canSeeSection(some, 'kids'), false);
  assert.equal(canSeeSection(some, undefined), false, 'an item of unknown library is hidden from non-admins');
  console.log('ok - a non-admin sees the shared subset');

  // null ("cannot tell") means nothing, and so does an empty share.
  assert.deepEqual(accessOf({ isAdmin: false, globalAdmin: false }, null), NO_SECTIONS);
  assert.equal(filterVisible(items, NO_SECTIONS).length, 0);
  assert.equal(filterVisible(items, accessOf({ isAdmin: false, globalAdmin: false }, [])).length, 0);
  console.log('ok - an unknown answer shows nothing');

  // The cache: a fresh answer is reused, a stale one is answered at once and refreshed behind.
  {
    const store = new Map<number, Entry>();
    let clock = 1_000_000;
    let answer: string[] | null = ['movies'];
    loads = 0;
    const load = async () => {
      loads += 1;
      return answer;
    };
    const opts = { store, now: () => clock, onUnknown: () => {} };
    assert.deepEqual(await resolveAccess(7, load, opts), ['movies'], 'a first lookup waits for the answer');
    assert.equal(loads, 1);
    clock += 5 * 60_000;
    assert.deepEqual(await resolveAccess(7, load, opts), ['movies']);
    assert.equal(loads, 1, 'fresh for ten minutes: no second request');

    answer = ['movies', 'shows'];
    clock += 6 * 60_000;
    assert.deepEqual(await resolveAccess(7, load, opts), ['movies'], 'stale: the old answer comes at once');
    await settle();
    assert.equal(loads, 2, '...and is refreshed in the background');
    assert.deepEqual(await resolveAccess(7, load, opts), ['movies', 'shows'], 'the next view has the new answer');

    // Parallel helpers of one page share one lookup.
    const cold = await Promise.all([resolveAccess(8, load, opts), resolveAccess(8, load, opts)]);
    assert.deepEqual(cold[0], cold[1]);
    assert.equal(loads, 3, 'two cold lookups for one person ask once');

    // A paused server is not asked; the stale answer stands.
    clock += 11 * 60_000;
    const paused = { ...opts, paused: async () => true };
    assert.deepEqual(await resolveAccess(7, load, paused), ['movies', 'shows']);
    await settle();
    assert.equal(loads, 3, 'no request to a server in a pause');
    console.log('ok - answers are cached per person, refreshed behind the page, not during a pause');
  }

  // Errors: the last answer stands; with none, nothing, logged once.
  {
    const store = new Map<number, Entry>();
    let clock = 5_000_000;
    let fail = false;
    const unknown: string[] = [];
    const load = async () => {
      if (fail) throw new Error('HTTP 503');
      return ['shows'];
    };
    const opts = { store, now: () => clock, onUnknown: (reason: string) => unknown.push(reason) };
    assert.deepEqual(await resolveAccess(1, load, opts), ['shows']);
    fail = true;
    clock += 11 * 60_000;
    assert.deepEqual(await resolveAccess(1, load, opts), ['shows']);
    await settle();
    assert.deepEqual(await resolveAccess(1, load, opts), ['shows'], 'a failed refresh keeps the last answer');
    assert.equal(unknown.length, 0, 'a known answer is not reported as unknown');

    assert.equal(await resolveAccess(2, load, opts), null, 'never answered: nothing');
    assert.equal(unknown.length, 1, 'and that is logged');
    let calls = 0;
    const counted = async () => {
      calls += 1;
      throw new Error('HTTP 503');
    };
    assert.equal(await resolveAccess(2, counted, opts), null);
    assert.equal(calls, 0, 'a failed cold lookup is not repeated on every view');
    clock += 61_000;
    assert.equal(await resolveAccess(2, counted, opts), null);
    await settle();
    assert.equal(calls, 1, 'but asked again a minute later');

    assert.equal(await resolveAccess(3, async () => null, opts), null, 'null from the server: nothing');
    console.log('ok - a failure keeps the last answer, a person never answered sees nothing');
  }

  // Plex can only be asked with the person's own token. Every answer is stored, and without any
  // token (sessions expired, a background mail, a preview) the stored one stands in.
  {
    const { createFirstServer } = await import('../server/config');
    const { db } = await import('../db');
    const { authSessions, userLibraryAccess, users } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const { globalState } = await import('../server/state');
    const { storedSectionIds } = await import('../server/library');
    const server = createFirstServer({ serverType: 'plex', serverUrl: 'http://plex-access:32400', serverToken: 'admin', label: 'P' })!;
    const [person] = await db.insert(users).values({ serverId: server.id, serverUserId: '42', username: 'friend' }).returning();
    const viewer = { id: person.id, serverId: server.id, serverUserId: '42', isAdmin: false, globalAdmin: false };
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url.pathname);
      if (url.pathname === '/') return Response.json({ MediaContainer: { machineIdentifier: 'm1' } });
      if (url.pathname === '/api/v2/resources') return Response.json([{ clientIdentifier: 'm1', accessToken: 'shared' }]);
      if (url.pathname === '/library/sections') {
        return Response.json({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }, { key: '3', type: 'show' }] } });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const forget = () => globalState('library.access', () => new Map()).clear();

    const live = await userSectionAccess(viewer, 'user-token');
    assert.deepEqual(live.all ? 'all' : [...live.ids], ['1', '3']);
    assert.deepEqual(await storedSectionIds(person.id), ['1', '3'], 'a successful answer is stored');

    // A restart later, the person's sessions are gone: no token to ask Plex with.
    forget();
    asked.length = 0;
    const offline = await userSectionAccess(viewer);
    assert.deepEqual(offline.all ? 'all' : [...offline.ids], ['1', '3'], 'the stored answer stands in');
    assert.deepEqual(asked, [], 'and nobody is asked with somebody else\'s token');

    // A live session's token is still preferred over the stored answer.
    await db.insert(authSessions).values({ id: 'h1', userId: person.id, serverToken: 'stored-token', expiresAt: new Date(Date.now() + 60_000) });
    await db.update(userLibraryAccess).set({ sectionIds: ['9'] }).where(eq(userLibraryAccess.userId, person.id));
    forget();
    const fresh = await userSectionAccess(viewer);
    assert.deepEqual(fresh.all ? 'all' : [...fresh.ids], ['1', '3'], 'asked with the stored session token first');
    assert.deepEqual(await storedSectionIds(person.id), ['1', '3'], 'and the new answer replaces the stored one');

    const [stranger] = await db.insert(users).values({ serverId: server.id, serverUserId: '43', username: 'new' }).returning();
    forget();
    const none = await userSectionAccess({ ...viewer, id: stranger.id, serverUserId: '43' });
    assert.equal(none.all, false);
    assert.equal(none.all ? -1 : none.ids.size, 0, 'never answered and no token: nothing, as before');
    console.log('ok - the last library answer is stored and used when there is no token to ask with');
  }

  // One Jellyfin library that fails no longer fails the whole refresh: the others are updated,
  // the broken one keeps what the cache held.
  {
    const { createServer } = await import('../server/config');
    const { getLibrary } = await import('../server/library');
    const jf = await createServer({ serverType: 'jellyfin', serverUrl: 'http://jf-partial:8096', serverToken: 't', label: 'J' });
    let version = 1;
    let failShows = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/Library/VirtualFolders') {
        return Response.json([
          { Name: 'Movies', ItemId: 'movies', CollectionType: 'movies' },
          { Name: 'Shows', ItemId: 'shows', CollectionType: 'tvshows' },
        ]);
      }
      const parent = url.searchParams.get('ParentId');
      if (failShows && parent === 'shows') return new Response('boom', { status: 500 });
      return Response.json({ Items: [{ Id: `${parent}-v${version}`, Name: `${parent} ${version}`, Type: 'Movie' }] });
    }) as typeof fetch;
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual((await getLibrary(jf.id, true)).map((i) => i.itemId).sort(), ['movies-v1', 'shows-v1']);
      version = 2;
      failShows = true;
      assert.deepEqual(
        (await getLibrary(jf.id, true)).map((i) => i.itemId).sort(),
        ['movies-v2', 'shows-v1'],
        'the working library is refreshed, the failed one keeps its last listing',
      );
    } finally {
      console.warn = warn;
    }
    console.log('ok - a failing library keeps its cached items while the others refresh');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
