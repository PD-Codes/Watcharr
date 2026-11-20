import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Security-relevant modules that had no suite of their own: the public API key check, the
// /adminlogin recovery code, the emergency account it creates, the "me / server" view rule and the
// translated API errors. Own throwaway database, set before anything opens the db module.
const dir = mkdtempSync(join(tmpdir(), 'watcharr-modules-test-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.SESSION_SECRET ??= 'test-secret';
execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'ignore', env: process.env });

// next/headers only exists inside a request. A cookie jar is all session.ts reads from it, so the
// module is swapped for one before session.ts is first loaded (same trick as routes.test.ts).
const jar = new Map<string, string>();
const Module = require('node:module') as { _load: (request: string, ...rest: unknown[]) => unknown };
const load = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'next/headers') {
    return {
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
      headers: async () => new Headers(),
    };
  }
  return load.call(this, request, ...rest);
};

/** Runs `fn` with console output captured; returns what was printed. */
async function captured(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const saved = [console.log, console.warn, console.error] as const;
  const keep = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
  console.log = keep;
  console.warn = keep;
  console.error = keep;
  try {
    await fn();
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
  return lines.join('\n');
}

async function main() {
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../db');
  const { users } = await import('../db/schema');
  const config = await import('../server/config');
  const session = await import('../server/session');
  const { RECOVERY_SERVER_USER_ID, RECOVERY_USERNAME } = await import('../server/recoveryaccount');

  // --- publicapi: the key, in a header or the query, and nothing else ----------------------
  {
    const { checkApiKey } = await import('../server/publicapi');
    const call = (path: string, headers: Record<string, string> = {}) =>
      checkApiKey(new Request(`http://app${path}`, { headers }));
    const bodyOf = async (res: Response | null) => (res ? ((await res.json()) as { code?: string }) : null);

    const off = await call('/api/v1/activity', { 'x-api-key': 'anything' });
    assert.equal(off?.status, 403, 'without an issued key the API is closed');
    assert.equal((await bodyOf(off))?.code, 'api-disabled');

    const key = await config.rotateApiKey();
    assert.equal(await call('/api/v1/activity', { 'x-api-key': key }), null, 'the key in the header opens it');
    assert.equal(await call(`/api/v1/activity?apikey=${encodeURIComponent(key)}`), null, 'the key in the query opens it');
    const wrong = await call('/api/v1/activity', { 'x-api-key': `${key}x` });
    assert.equal(wrong?.status, 401, 'a wrong key is refused');
    assert.equal((await bodyOf(wrong))?.code, 'invalid-api-key');
    assert.equal((await call('/api/v1/activity'))?.status, 401, 'a missing key is refused');
    assert.equal((await call('/api/v1/activity?apikey='))?.status, 401, 'an empty key is refused');
    assert.equal((await call(`/api/v1/activity?apikey=${key.slice(0, -1)}`))?.status, 401, 'a prefix is not the key');

    const rotated = await config.rotateApiKey();
    assert.equal((await call('/api/v1/activity', { 'x-api-key': key }))?.status, 401, 'a rotated-out key stops working');
    assert.equal(await call('/api/v1/activity', { 'x-api-key': rotated }), null);
    await config.updateSettings({ apiKey: null });
    assert.equal((await call('/api/v1/activity', { 'x-api-key': rotated }))?.status, 403, 'switched off, every key is refused');
    console.log('ok - publicapi: header or query key, wrong/missing key refused, off means off');
  }

  // --- adminrecovery + recoveryaccount: one code, once, in time ------------------------------
  {
    const { requestRecoveryCode, redeemRecoveryCode } = await import('../server/adminrecovery');
    const { globalState } = await import('../server/state');
    const codeIn = (text: string) => text.match(/adminlogin\?token=([A-Z0-9]{20})/)?.[1] ?? '';
    const ask = async (ip: string) => {
      let ok = false;
      const printed = await captured(async () => {
        ok = await requestRecoveryCode('', ip);
      });
      assert.ok(ok, 'the request is answered');
      return codeIn(printed);
    };
    const redeem = (code: string, ip: string) => redeemRecoveryCode(code, { ip });
    // A successful redeem logs who used the back door; kept out of the test output.
    const redeemQuietly = async (code: string, ip: string) => {
      let result = '';
      await captured(async () => {
        result = await redeem(code, ip);
      });
      return result;
    };

    // No server yet: the code cannot create the emergency account and stays valid for later.
    const early = await ask('10.1.0.1');
    assert.ok(early, 'the code is printed to the console');
    assert.equal(await redeem(early, '10.1.0.1'), 'no-server');

    const server = config.createFirstServer({
      serverType: 'jellyfin',
      serverUrl: 'http://media.test',
      serverToken: 't',
      label: 'Main',
    })!;
    assert.equal(await redeem('WRONG-WRONG-WRONG-WRONG', '10.1.0.2'), 'invalid', 'a wrong code signs nobody in');
    assert.equal(jar.size, 0, 'and sets no cookie');

    // Valid, once: nobody holds the global admin role, so the emergency account is created.
    jar.clear();
    assert.equal(await redeemQuietly(early.toLowerCase(), '10.1.0.3'), 'ok', 'letter case does not matter');
    const [emergency] = await db.select().from(users).where(eq(users.serverUserId, RECOVERY_SERVER_USER_ID));
    assert.ok(emergency, 'the emergency account exists');
    assert.equal(emergency.username, RECOVERY_USERNAME);
    assert.equal(emergency.serverId, server.id);
    assert.equal(emergency.globalAdmin, true, 'and holds the global admin role');
    assert.equal((await session.getSession())?.user.id, emergency.id, 'the browser is signed in as it');
    assert.equal(await redeem(early, '10.1.0.4'), 'invalid', 'a code works only once');
    console.log('ok - adminrecovery: a valid code signs in once, a wrong one never');

    // Expired: the same code a minute after its time is up is just a wrong code.
    const late = await ask('10.1.0.5');
    assert.ok(late && late !== early, 'a fresh code after the old one was used');
    const recovery = globalState('adminRecovery', () => ({ token: null as string | null, expires: 0 }));
    recovery.expires = Date.now() - 60_000;
    assert.equal(await redeem(late, '10.1.0.6'), 'invalid', 'an expired code is refused');
    console.log('ok - adminrecovery: an expired code is refused');

    // Somebody floods wrong codes from made-up addresses until the global limit is reached: the
    // admin's current code still signs in, only wrong ones are turned away.
    const current = await ask('10.1.0.7');
    for (let i = 0; i < 50; i += 1) await redeem('WRONG-WRONG-WRONG-WRONG', `10.1.9.${i}`);
    assert.equal(await redeem('WRONG-WRONG-WRONG-WRONG', '10.1.8.1'), 'limited', 'wrong codes wait');
    jar.clear();
    assert.equal(await redeemQuietly(current, '10.1.8.1'), 'ok', 'the current code is never locked out');
    console.log('ok - adminrecovery: the global limit holds back guesses, never the current code');

    // The server owner signs in through the media server: the role passes to them and the
    // emergency account steps down, kept (it is the record of who used the back door).
    jar.clear();
    const owner = await session.createSession(server.id, { serverUserId: 'owner', username: 'owner', isAdmin: true }, 'tok');
    assert.equal(owner.globalAdmin, true, 'the real admin takes the role the emergency account held');
    const [demoted] = await db.select().from(users).where(eq(users.id, emergency.id));
    assert.ok(demoted, 'the emergency account is demoted, not deleted');
    assert.equal(demoted.globalAdmin, false);
    assert.equal(demoted.isAdmin, false);

    // From now on a code signs in as that admin and creates no second emergency account.
    const third = await ask('10.1.0.7');
    jar.clear();
    assert.equal(await redeemQuietly(third, '10.1.0.8'), 'ok');
    assert.equal((await session.getSession())?.user.id, owner.id, 'the code signs in as the real global admin');
    const emergencies = await db.select().from(users).where(eq(users.serverUserId, RECOVERY_SERVER_USER_ID));
    assert.equal(emergencies.length, 1, 'no second emergency account');
    assert.equal(emergencies[0].globalAdmin, false, 'and the old one stays demoted');
    console.log('ok - recoveryaccount: created without an admin, demoted once a real admin signs in');
  }

  // --- viewscope: "me" unless the server view is allowed ------------------------------------
  {
    const { resolveView } = await import('../server/viewscope');
    const [main] = await config.listServers();
    const second = await config.createServer({
      serverType: 'jellyfin',
      serverUrl: 'http://other.test',
      serverToken: 't2',
      label: 'Other',
    });
    const reader = async (serverUserId: string, roles: { isAdmin?: boolean; globalAdmin?: boolean }, serverId = main.id) => {
      const [row] = await db
        .insert(users)
        .values({ serverId, serverUserId, username: serverUserId, isAdmin: !!roles.isAdmin, globalAdmin: !!roles.globalAdmin })
        .returning();
      const own = serverId === main.id ? main : second;
      return { id: 'x', user: row, serverToken: '', server: { id: own.id, label: own.label, slug: own.slug } };
    };
    const viewer = await reader('viewer', {});
    const serverAdmin = await reader('second-admin', { isAdmin: true }, second.id);
    const [globalRow] = await db.select().from(users).where(eq(users.serverUserId, 'owner'));
    const globalAdmin = { id: 'x', user: globalRow, serverToken: '', server: { id: main.id, label: main.label, slug: main.slug } };

    const plain = await resolveView(viewer, { view: 'server' });
    assert.equal(plain.kind, 'me', 'a non-admin asking for the server view gets their own');
    assert.equal(plain.canServer, false);
    assert.deepEqual(plain.scope, { userId: viewer.user.id });
    assert.equal((await resolveView(viewer, {}, 'server')).kind, 'me', 'a server fallback does not apply to a non-admin');

    const own = await resolveView(serverAdmin, { view: 'server', server: main.slug });
    assert.equal(own.kind, 'server');
    assert.deepEqual(own.scope, { userId: null, serverId: second.id }, 'a server admin stays on their own server, whatever slug');
    assert.deepEqual(own.servers.map((s) => s.id), [second.id], 'and is offered no other');
    assert.equal((await resolveView(serverAdmin, {})).kind, 'me', 'without ?view the default is "me"');
    assert.equal((await resolveView(serverAdmin, {}, 'server')).kind, 'server', 'unless the page falls back to the server');
    assert.equal((await resolveView(serverAdmin, { view: ['server', 'me'] })).kind, 'server', 'the first of repeated params counts');

    const picked = await resolveView(globalAdmin, { view: 'server', server: second.slug });
    assert.deepEqual(picked.scope, { userId: null, serverId: second.id }, 'a global admin may pick another server');
    assert.equal(picked.servers.length, 2);
    const unknown = await resolveView(globalAdmin, { view: 'server', server: 'no-such-server' });
    assert.equal(unknown.server.id, main.id, 'an unknown slug falls back to their own server');
    assert.equal((await resolveView(globalAdmin, { view: 'me', server: second.slug })).kind, 'me');
    console.log('ok - viewscope: me/server per role, foreign slugs only for a global admin');
  }

  // --- apierror: the reader's language, a stable code, no internals ---------------------------
  {
    const { apiError, badBody, unauthorized, withApiErrors } = await import('../server/apierror');
    const read = async (res: Response): Promise<Record<string, unknown>> => ({ status: res.status, ...(await res.json()) });

    jar.clear();
    const anonymous = await read(await apiError(404, 'user-not-found', 'err.userNotFound'));
    assert.deepEqual(anonymous, { status: 404, error: 'User not found', code: 'user-not-found' }, 'no session: the default language');
    await config.updateSettings({ defaultLocale: 'de-DE' });
    assert.equal((await read(await unauthorized())).error, 'Bitte melde dich zuerst an.', 'no session: the deployment default');
    await config.updateSettings({ defaultLocale: 'en-US' });

    const [german] = await db.select().from(users).where(eq(users.serverUserId, 'viewer'));
    await session.createSession(german.serverId, { serverUserId: 'viewer', username: 'viewer', isAdmin: false }, 'tok');
    await session.setUserLocale(german.id, 'de-DE');
    const translated = await read(await badBody());
    assert.equal(translated.error, 'Die Anfrage ist ungültig.', 'a de-DE user reads German');
    assert.equal(translated.code, 'bad-body', 'and the code does not change with the language');
    const withVars = await read(await apiError(501, 'unsupported', 'err.terminateUnsupported', { vars: { type: 'plex' } }));
    assert.equal(withVars.error, 'plex kann Streams nicht beenden.');
    const reason = await read(await apiError(409, 'disabled', 'err.quickConnectDisabled', { codeField: 'reason' }));
    assert.equal(reason.reason, 'disabled', 'the code can go into `reason`');
    assert.equal(reason.code, undefined);
    const passed = await read(await apiError(502, 'send-failed', 'err.sendFailed', { message: 'SMTP 550', extra: { to: 'a' } }));
    assert.deepEqual(passed, { status: 502, error: 'SMTP 550', code: 'send-failed', to: 'a' }, 'a module message wins over the key');

    const failing = withApiErrors(async (_request: Request) => {
      throw new Error('SQLITE_BUSY at /data/watcharr.db');
    });
    let answer: Record<string, unknown> = {};
    const log = await captured(async () => {
      answer = await read(await failing(new Request('http://app/api/thing', { method: 'POST' })));
    });
    assert.equal(answer.status, 500);
    assert.equal(answer.code, 'unexpected');
    assert.equal(answer.error, 'Etwas ist schiefgelaufen. Bitte versuche es erneut.', 'the 500 is translated too');
    assert.ok(!JSON.stringify(answer).includes('SQLITE'), 'the answer carries no internals');
    assert.match(log, /POST \/api\/thing failed/, 'the log names the route');
    assert.match(log, /SQLITE_BUSY/, 'and keeps the detail');
    const fine = await withApiErrors(async () => Response.json({ ok: true }))();
    assert.equal(fine.status, 200, 'a handler that works is passed through');
    console.log('ok - apierror: German for a de-DE user, default without a session, 500 without details');
  }
}

// --- watchlist sync rules: what goes to Plex, and which pulled row is one kept here ----------
async function watchlistRules() {
  const { pushableToServer, sameWatchlistTitle } = await import('../server/watchlistmatch');
  for (const kind of ['movie', 'show', 'series', 'Movie']) assert.ok(pushableToServer(kind), `${kind} goes to plex.tv`);
  for (const kind of ['episode', 'season', 'unknown', '', null, undefined]) {
    assert.ok(!pushableToServer(kind), `${kind} stays local: as its show it would add or remove the whole show`);
  }

  const row = (title: string, mediaType: string | null, year?: number) => ({ itemId: 'x', title, mediaType, year });
  assert.ok(sameWatchlistTitle(row('Dune', 'movie', 2021), row('dune ', 'movie', 2021)));
  assert.ok(!sameWatchlistTitle(row('Dune', 'movie', 2021), row('Dune', 'movie', 1984)), 'another year is another title');
  assert.ok(sameWatchlistTitle(row('Dune', null, 2021), row('Dune', 'movie', 2021)), 'with both years, an unknown kind still matches');
  assert.ok(sameWatchlistTitle(row('The Office', 'show'), row('The Office', 'show', 2005)), 'no year, same kind: the same title');
  assert.ok(sameWatchlistTitle(row('Heat', 'movie'), row('Heat', 'movie')));
  assert.ok(!sameWatchlistTitle(row('The Office', 'movie'), row('The Office', 'show', 2005)), 'no year and another kind: not the same');
  assert.ok(!sameWatchlistTitle(row('The Office', null), row('The Office', 'show')), 'no year and an unknown kind: not enough to merge');
  assert.ok(!sameWatchlistTitle(row('Pilot', 'episode'), row('Pilot', 'episode')), 'episodes never stand for each other by title alone');
  console.log('ok - watchlist: only movies and shows go to Plex, a title without a year needs the same kind');
}

main()
  .then(watchlistRules)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
