import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Own throwaway database and scripts folder, set before anything that reads them is imported
// (the db module connects on load, notifications.ts reads the scripts folder on load).
const dir = mkdtempSync(join(tmpdir(), 'watcharr-security-test-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.SESSION_SECRET ??= 'test-secret';
process.env.WATCHARR_SCRIPTS_DIR = join(dir, 'scripts');
delete process.env.APP_URL;
execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'ignore', env: process.env });

/** Runs `fn` with console.log/warn captured; returns what was printed. */
async function captured(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const [log, warn] = [console.log, console.warn];
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  console.warn = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines.join('\n');
}

async function main() {
  const { createFirstServer } = await import('../server/config');
  const { db } = await import('../db');
  const { authSessions, loginHistory, notificationChannels, notificationLog, users } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const session = await import('../server/session');

  const server = createFirstServer({
    serverType: 'jellyfin',
    serverUrl: 'http://media.test',
    serverToken: 't',
    label: 'Main',
  })!;
  const day = 86_400_000;
  const addSession = async (userId: number, id = randomBytes(32).toString('hex')) => {
    await db.insert(authSessions).values({
      id: session.sessionHandle(id),
      userId,
      serverToken: 'x',
      expiresAt: new Date(Date.now() + day),
    });
    return id;
  };
  const sessionsOf = async (userId: number) =>
    (await db.select().from(authSessions).where(eq(authSessions.userId, userId))).length;

  // --- Setup token and recovery: limits that do not trust X-Forwarded-For -----------------
  // Run first, while nobody holds the global admin role (the setup token is only live then).
  {
    const { announceSetupToken, checkSetupToken } = await import('../server/setuptoken');
    const printed = await captured(() => announceSetupToken());
    const token = printed.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)?.[1];
    assert.ok(token);
    // One wrong guess from each of 50 made-up addresses: no single address hits its own limit.
    for (let i = 0; i < 50; i += 1) assert.equal(await checkSetupToken('WRONG-TOKN', `10.9.0.${i}`), 'invalid');
    assert.equal(await checkSetupToken('WRONG-TOKN', '10.9.1.1'), 'limited', 'past the global limit a wrong guess waits');
    assert.equal(
      await checkSetupToken(token, '10.9.1.1'),
      'valid',
      'the right token always gets through: somebody else\'s guessing cannot lock the admin out',
    );
    for (let i = 0; i < 8; i += 1) await checkSetupToken('WRONG-TOKN', '10.9.2.1');
    assert.equal(await checkSetupToken(token, '10.9.2.1'), 'valid', 'not even this address\'s own limit stops it');
    console.log('ok - setup token guesses are limited across all addresses, the right token never is');

    const { checkRecoveryCode, requestRecoveryCode, redeemRecoveryCode } = await import('../server/adminrecovery');
    const codeIn = (text: string) => text.match(/adminlogin\?token=([A-Z0-9]{20})/)?.[1];
    const first = await captured(async () => assert.ok(await requestRecoveryCode('', '10.8.0.1')));
    const second = await captured(async () => assert.ok(await requestRecoveryCode('', '10.8.0.2')));
    assert.ok(codeIn(first), first);
    assert.equal(codeIn(second), codeIn(first), 'asking again prints the pending code instead of replacing it');
    assert.ok(/\(from 10\.8\.0\.2\)/.test(second), 'the log names who asked this time');
    assert.ok(!/https?:\/\//.test(first), 'without APP_URL no host is printed, only the path');
    const linked = await captured(() => requestRecoveryCode('https://watcharr.example', '10.8.0.3'));
    assert.ok(linked.includes(`https://watcharr.example/adminlogin?token=${codeIn(first)}`));
    console.log('ok - a recovery request reprints a valid code and prints no request-supplied host');

    // Ten requests per window in total (three above), whatever the address says. Past that the
    // way in stays open: the pending code stands and is not printed again within a minute.
    for (let i = 0; i < 7; i += 1) {
      await captured(async () => assert.ok(await requestRecoveryCode('', `10.8.1.${i}`), `request ${i}`));
    }
    const flooded = await captured(async () =>
      assert.equal(await requestRecoveryCode('', '10.8.2.1'), true, 'the eleventh request is not refused'),
    );
    assert.equal(flooded, '', 'but the console is not flooded: the code was printed a moment ago');
    const realClock = Date.now;
    Date.now = () => realClock() + 61_000;
    const reprinted = await captured(() => requestRecoveryCode('', '10.8.2.2'));
    Date.now = realClock;
    assert.equal(codeIn(reprinted), codeIn(first), 'a minute later the same code is printed again, none is made');
    for (let i = 0; i < 5; i += 1) await captured(() => requestRecoveryCode('', '10.8.4.1'));
    assert.equal(await requestRecoveryCode('', '10.8.4.1'), false, 'one address asking too often is still refused');
    console.log('ok - recovery requests past the global limit keep the pending code instead of blocking');

    for (let i = 0; i < 50; i += 1) {
      assert.equal(await redeemRecoveryCode('AAAAA-AAAAA-AAAAA-AAAAA', { ip: `10.7.0.${i}` }), 'invalid');
    }
    assert.equal(await redeemRecoveryCode('AAAAA-AAAAA-AAAAA-AAAAA', { ip: '10.7.1.1' }), 'limited', 'a wrong code waits');
    assert.equal(checkRecoveryCode(codeIn(first)!, '10.7.1.1'), 'valid', 'the current code is never limited');
    console.log('ok - recovery code guesses are limited across all addresses, the current code never is');

    // Once the code has run out, a request makes a new one (the windows have passed too).
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000;
    const later = await captured(() => requestRecoveryCode('', '10.8.3.1'));
    Date.now = realNow;
    assert.ok(codeIn(later) && codeIn(later) !== codeIn(first), 'an expired code is replaced');
  }

  // --- Roster reconciliation --------------------------------------------------------------
  const { ensureUsers, reconcileRoster } = await import('../server/userroster');
  const { RECOVERY_SERVER_USER_ID } = await import('../server/recoveryaccount');
  const made = await db
    .insert(users)
    .values([
      { serverId: server.id, serverUserId: 'adm', username: 'Admin', isAdmin: true, globalAdmin: true },
      { serverId: server.id, serverUserId: 'pro', username: 'Promoted', isAdmin: false },
      { serverId: server.id, serverUserId: 'dem', username: 'Demoted', isAdmin: true },
      { serverId: server.id, serverUserId: 'gone', username: 'Gone', isAdmin: false },
      { serverId: server.id, serverUserId: 'idle', username: 'Idle', isAdmin: false },
      { serverId: server.id, serverUserId: RECOVERY_SERVER_USER_ID, username: 'watcharr-admin', isAdmin: true },
    ])
    .returning();
  const byName = Object.fromEntries(made.map((u) => [u.username, u]));
  for (const u of made) await addSession(u.id);
  const roster = [
    { serverUserId: 'adm', username: 'Admin', isAdmin: false },
    { serverUserId: 'pro', username: 'Promoted', isAdmin: true },
    { serverUserId: 'dem', username: 'Demoted', isAdmin: false },
    { serverUserId: 'other', username: 'Somebody', isAdmin: true },
  ];

  // Neither a list from streams/imports (no isAdmin) nor an empty one acts on anybody.
  await ensureUsers(server.id, [{ serverUserId: 'pro', username: 'Promoted' }]);
  assert.equal(await reconcileRoster(server.id, []).then((c) => c.sessionsRevoked), 0);
  assert.equal(await sessionsOf(byName.Gone.id), 1, 'a partial list signs nobody out');

  // A list without any admin is incomplete (Plex without plex.tv): nothing at all is changed.
  const skipped = await captured(async () => {
    const changes = await reconcileRoster(server.id, [
      { serverUserId: 'adm', username: 'Admin', isAdmin: false },
      { serverUserId: 'dem', username: 'Demoted', isAdmin: false },
    ]);
    assert.deepEqual(changes, { roleChanged: 0, removed: 0, sessionsRevoked: 0 });
  });
  assert.match(skipped, /names no admin/, 'and says so');
  assert.equal(await sessionsOf(byName.Gone.id), 1, 'nobody is signed out on an incomplete list');
  assert.equal((await db.select().from(users).where(eq(users.id, byName.Demoted.id)))[0].isAdmin, true, 'nobody is demoted');
  assert.equal(await sessionsOf(byName.Demoted.id), 1);

  // A list that would sign out more than half of the signed-in people (and more than two):
  // held back as an incomplete list; role changes still follow.
  const mass = await captured(async () => {
    const changes = await reconcileRoster(server.id, [
      { serverUserId: 'adm', username: 'Admin', isAdmin: true },
      { serverUserId: 'pro', username: 'Promoted', isAdmin: false },
    ]);
    assert.equal(changes.removed, 0, 'Demoted, Gone and Idle would be three of five: not acted on');
  });
  assert.match(mass, /nobody is signed out/);
  assert.equal(await sessionsOf(byName.Gone.id), 1);
  assert.equal(await sessionsOf(byName.Idle.id), 1);
  assert.equal(await sessionsOf(byName.Demoted.id), 1);

  const log = await captured(() => ensureUsers(server.id, roster));
  const row = async (id: number) => (await db.select().from(users).where(eq(users.id, id)))[0];
  assert.equal((await row(byName.Promoted.id)).isAdmin, true, 'a new admin flag is taken over');
  assert.equal((await row(byName.Demoted.id)).isAdmin, false, 'a removed admin flag is taken over');
  assert.equal(await sessionsOf(byName.Promoted.id), 0, 'a role change signs the person out');
  assert.equal(await sessionsOf(byName.Demoted.id), 0);
  assert.equal(await sessionsOf(byName.Gone.id), 0, 'somebody no longer on the server is signed out');
  assert.equal(await sessionsOf(byName.Idle.id), 0);
  assert.equal(await sessionsOf(byName['watcharr-admin'].id), 1, 'the emergency account is left alone');
  assert.equal((await row(byName['watcharr-admin'].id)).isAdmin, true);
  const admin = await row(byName.Admin.id);
  assert.equal(admin.isAdmin, false);
  assert.equal(admin.globalAdmin, true, 'the global admin role is never changed automatically');
  assert.match(log, /Admin keeps the Watcharr global admin role/);
  const somebody = (await db.select().from(users).where(eq(users.serverUserId, 'other')))[0];
  assert.equal(somebody?.isAdmin, true, 'a new row from the user list carries its flag');
  console.log('ok - the roster sync brings roles and removed shares in line');

  // --- Session ids are stored hashed ------------------------------------------------------
  {
    const [person] = await db
      .insert(users)
      .values({ serverId: server.id, serverUserId: 'sess', username: 'Sessions' })
      .returning();
    const fresh = await addSession(person.id);
    const stored = (await db.select().from(authSessions).where(eq(authSessions.userId, person.id)))[0];
    assert.notEqual(stored.id, fresh, 'the table never holds the cookie id');
    assert.equal(stored.id, createHash('sha256').update(fresh).digest('base64url'));
    const found = await session.sessionForCookieId(fresh);
    assert.equal(found?.user.id, person.id);
    assert.equal(found?.id, stored.id, 'Session.id is the handle');

    // A row from before hashing: the cookie still works and the row is rewritten on the spot.
    const legacy = randomBytes(32).toString('hex');
    await db.insert(authSessions).values({ id: legacy, userId: person.id, serverToken: 'x', expiresAt: new Date(Date.now() + day) });
    const old = await session.sessionForCookieId(legacy);
    assert.equal(old?.user.id, person.id, 'a session from before the update stays signed in');
    const ids = (await db.select().from(authSessions).where(eq(authSessions.userId, person.id))).map((r) => r.id);
    assert.ok(!ids.includes(legacy), 'and its raw id is gone from the table');
    assert.ok(ids.includes(session.sessionHandle(legacy)));
    assert.equal((await session.sessionForCookieId(legacy))?.id, session.sessionHandle(legacy), 'again, by handle');

    // Several requests with the same old cookie at once: one rewrites the row, the others find
    // nothing left to rewrite, and every one of them must still be signed in.
    const racing = randomBytes(32).toString('hex');
    await db.insert(authSessions).values({ id: racing, userId: person.id, serverToken: 'x', expiresAt: new Date(Date.now() + day) });
    const parallel = await Promise.all([1, 2, 3].map(() => session.sessionForCookieId(racing)));
    assert.ok(parallel.every((s) => s?.user.id === person.id), 'parallel requests with one old cookie all stay signed in');
    await session.revokeSession(session.sessionHandle(racing));

    // Listing upgrades leftovers first, so a raw id never reaches the admin UI.
    const leftover = randomBytes(32).toString('hex');
    await db.insert(authSessions).values({ id: leftover, userId: person.id, serverToken: 'x', expiresAt: new Date(Date.now() + day) });
    const listed = (await session.listUserSessions(person.id)).map((s) => s.id);
    assert.equal(listed.length, 3);
    assert.ok(!listed.includes(leftover) && listed.includes(session.sessionHandle(leftover)));
    assert.equal(await session.sessionForCookieId(session.sessionHandle(fresh)), null, 'a handle is no cookie id');
    await session.revokeSession(session.sessionHandle(leftover));
    assert.equal(await session.sessionForCookieId(leftover), null, 'revoking by handle ends that sign-in');
    assert.equal(await session.revokeUserSessions(person.id), 2);
    console.log('ok - session ids are stored hashed and older sessions are upgraded, not signed out');
  }

  // --- Split keys, with the pre-split ones still accepted ---------------------------------
  {
    const { decryptSecret, encryptSecret, hmacSign, hmacVerify } = await import('../server/crypto');
    const secret = process.env.SESSION_SECRET!;
    const id = randomBytes(32).toString('hex');
    const legacyMac = createHmac('sha256', secret).update(id).digest('hex');
    assert.ok(hmacVerify('session-cookie', id, hmacSign('session-cookie', id)));
    assert.notEqual(hmacSign('session-cookie', id), legacyMac, 'new cookies use the derived key');
    assert.ok(hmacVerify('session-cookie', id, legacyMac), 'a cookie signed before the update still verifies');
    assert.ok(!hmacVerify('view-as', id, hmacSign('session-cookie', id)), 'a value signed for one purpose fails another');
    assert.notEqual(hmacSign('plex-pin', id), hmacSign('session-cookie', id));
    assert.ok(!hmacVerify('session-cookie', id, createHmac('sha256', 'other').update(id).digest('hex')));
    assert.ok(!hmacVerify('session-cookie', id, 'zz'), 'garbage is no signature');

    // An artwork link handed out by the previous release keeps working until it expires.
    const { verifyArtSignature } = await import('../server/artlink');
    const exp = Date.now() + 60_000;
    const oldSig = createHmac('sha256', secret).update(`main:abc:${exp}`).digest('hex');
    assert.ok(verifyArtSignature('main', 'abc', exp, oldSig));
    assert.ok(!verifyArtSignature('main', 'abd', exp, oldSig));

    // A token encrypted by the previous release (v1, key = sha256(secret)) stays readable.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
    const data = Buffer.concat([cipher.update('old-token', 'utf8'), cipher.final()]);
    const v1 = `v1:${[iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':')}`;
    assert.equal(decryptSecret(v1), 'old-token', 'stored tokens from before the update decrypt');
    const v2 = encryptSecret('new-token');
    assert.ok(v2.startsWith('v2:'), 'new values use the derived key');
    assert.equal(decryptSecret(v2), 'new-token');
    assert.throws(() => decryptSecret(`v1:${v2.slice(3)}`), 'the old key cannot open a new value');
    assert.equal(decryptSecret('plain'), 'plain', 'values from before encryption are untouched');
    console.log('ok - keys are split per purpose and the old ones are still accepted for reading');
  }

  // --- The last global admin, atomically --------------------------------------------------
  {
    await db.update(users).set({ globalAdmin: false });
    const [a, b] = await db
      .insert(users)
      .values([
        { serverId: server.id, serverUserId: 'ga-a', username: 'ga-a', globalAdmin: true },
        { serverId: server.id, serverUserId: 'ga-b', username: 'ga-b', globalAdmin: true },
      ])
      .returning();
    const results = await Promise.all([session.setGlobalAdmin(a.id, false), session.setGlobalAdmin(b.id, false)]);
    assert.deepEqual([...results].sort(), ['last-admin', 'ok'], 'two revocations at once: exactly one wins');
    assert.equal(await session.countGlobalAdmins(), 1);
    assert.equal(await session.setGlobalAdmin(999_999, true), 'unknown');
    const [plain] = await db.insert(users).values({ serverId: server.id, serverUserId: 'ga-c', username: 'ga-c' }).returning();
    assert.equal(await session.setGlobalAdmin(plain.id, false), 'ok', 'revoking from a non-admin is no error');
    assert.equal(await session.setGlobalAdmin(plain.id, true), 'ok');
    assert.equal(await session.countGlobalAdmins(), 2);
    console.log('ok - the last global admin cannot be removed, even by two requests at once');
  }

  // --- Deleting a person keeps the trail of failed logins ---------------------------------
  {
    const { deleteUserWithData } = await import('../server/userdelete');
    const [victim] = await db
      .insert(users)
      .values({ serverId: server.id, serverUserId: 'victim', username: 'victim' })
      .returning();
    await db.insert(loginHistory).values([
      { serverId: server.id, userId: victim.id, username: 'victim', success: true, ip: '10.0.0.1' },
      { serverId: server.id, userId: victim.id, username: 'victim', success: false, ip: '203.0.113.7' },
      { serverId: server.id, userId: null, username: 'victim', success: false, ip: '203.0.113.8' },
    ]);
    await db.insert(loginHistory).values([
      { serverId: server.id, userId: null, username: 'Victim2', success: false, ip: '203.0.113.9' },
      { serverId: server.id + 1, userId: null, username: 'victim', success: false, ip: '203.0.113.10' },
    ]);
    const { DELETED_USERNAME } = await import('../server/userdelete');
    assert.ok(deleteUserWithData(victim.id));
    const left = await db.select().from(loginHistory).where(eq(loginHistory.username, DELETED_USERNAME));
    assert.deepEqual(left.map((r) => r.ip).sort(), ['203.0.113.7', '203.0.113.8'], 'failed attempts stay, addresses included');
    assert.ok(left.every((r) => r.userId === null && !r.success), 'unlinked from the deleted account');
    assert.equal((await db.select().from(loginHistory).where(eq(loginHistory.username, 'victim'))).length, 1,
      'the name is gone from the kept attempts; the same name on another server is somebody else');
    assert.equal((await db.select().from(loginHistory).where(eq(loginHistory.username, 'Victim2'))).length, 1,
      'another name is left alone');
    await db.delete(loginHistory).where(eq(loginHistory.serverId, server.id + 1));
    console.log('ok - deleting a person removes their sign-ins and keeps failed attempts without their name');
  }

  // --- Quick Connect: a global start limit and no ready-made approval link ----------------
  {
    const { allowQuickConnectStart, jellyfinQuickConnectUrl } = await import('../server/quickconnect');
    let allowed = 0;
    for (let i = 0; i < 40; i += 1) if (allowQuickConnectStart(77, `10.6.0.${i}`)) allowed += 1;
    assert.equal(allowed, 30, 'starts from made-up addresses run into the limit for everybody together');
    assert.equal(allowQuickConnectStart(77, '10.6.1.1'), false, 'a fresh address too, until the window passes');
    assert.equal(allowQuickConnectStart(78, '10.6.1.1'), true, 'per server');
    for (let i = 0; i < 10; i += 1) assert.ok(allowQuickConnectStart(79, '10.6.2.1'));
    assert.equal(allowQuickConnectStart(79, '10.6.2.1'), false, 'and the per-address limit still holds');
    assert.equal(jellyfinQuickConnectUrl('https://jf.example/'), 'https://jf.example/web/index.html#/quickconnect');
    assert.ok(!jellyfinQuickConnectUrl('https://jf.example')?.includes('code'), 'never a pre-filled code');
    assert.equal(jellyfinQuickConnectUrl('http://jellyfin:8096'), null);
    console.log('ok - Quick Connect starts are limited for everybody together and the link carries no code');
  }

  // --- Paging the logs --------------------------------------------------------------------
  {
    const { countLoginHistory, listLoginHistory } = session;
    const total = await countLoginHistory();
    const all = await listLoginHistory(undefined, 1_000);
    assert.equal(all.length, total);
    const page = await listLoginHistory(undefined, 1, 1);
    assert.equal(page[0]?.id, all[1]?.id, 'offset skips the newest');
    assert.equal(await countLoginHistory(server.id), total);
    assert.equal(await countLoginHistory(424242), 0);

    const { countNotificationLog, listNotificationLog } = await import('../server/notifications');
    await db.insert(notificationLog).values(
      [1, 2, 3].map((n) => ({ channelType: 'webhook', channelName: `c${n}`, event: 'digest', success: true })),
    );
    assert.equal(await countNotificationLog(), 3);
    assert.equal((await listNotificationLog()).length, 3, 'the default page is unchanged');
    assert.equal((await listNotificationLog(2, 2)).length, 1);
    console.log('ok - login and notification logs can be paged and counted');
  }

  // --- A stored secret does not follow a new destination ----------------------------------
  {
    const { createChannel, retargetsSecret, sameEndpoint, updateChannel } = await import('../server/notifications');
    const smtp = { smtpHost: 'mail.example', smtpPort: '587', smtpUser: 'u', smtpPass: 'secret' };
    assert.equal(retargetsSecret('email', smtp, { smtpHost: 'evil.example' }), true);
    assert.equal(retargetsSecret('email', smtp, { smtpPort: '2525' }), true);
    assert.equal(retargetsSecret('email', smtp, { smtpHost: 'evil.example', smtpPass: 'new' }), false);
    assert.equal(retargetsSecret('email', smtp, { smtpHost: ' MAIL.example ', from: 'x@y' }), false);
    assert.equal(retargetsSecret('email', { ...smtp, smtpPass: '' }, { smtpHost: 'other' }), false);
    assert.equal(retargetsSecret('discord', { url: 'https://a' }, { url: 'https://b' }), false);

    const { id } = await createChannel({ type: 'email', name: 'mail', config: smtp, events: [] });
    const refused = await updateChannel(id, { name: 'renamed', config: { smtpHost: 'evil.example' } });
    assert.equal(refused.ok, false);
    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id));
    assert.equal(row.name, 'mail', 'a refused edit writes nothing');
    assert.equal((await updateChannel(id, { config: { smtpHost: 'new.example', smtpPass: 'p2' } })).ok, true);
    assert.equal((await updateChannel(id, { config: { from: 'a@b' } })).ok, true);

    assert.ok(sameEndpoint('http://media.test', 'http://media.test:80/jellyfin'));
    assert.ok(sameEndpoint('https://Media.Test/', 'https://media.test:443'));
    assert.ok(!sameEndpoint('http://media.test', 'https://media.test'));
    assert.ok(!sameEndpoint('http://media.test', 'http://media.test:8096'));
    assert.ok(!sameEndpoint('http://media.test', 'http://evil.test'));
    assert.ok(!sameEndpoint('http://media.test', 'not a url'));
    console.log('ok - a changed destination needs its secret entered again');
  }

  // --- The script channel ends everything it started --------------------------------------
  if (process.platform !== 'win32') {
    const { runScript } = await import('../server/notifications');
    const scripts = process.env.WATCHARR_SCRIPTS_DIR!;
    mkdirSync(scripts, { recursive: true });
    const pidFile = join(dir, 'grandchild.pid');
    writeFileSync(join(scripts, 'hang.sh'), `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nsleep 30\n`);
    writeFileSync(join(scripts, 'fail.sh'), '#!/bin/sh\necho broken >&2\nexit 3\n');
    writeFileSync(join(scripts, 'fine.sh'), '#!/bin/sh\nexit 0\n');
    for (const name of ['hang.sh', 'fail.sh', 'fine.sh']) chmodSync(join(scripts, name), 0o755);

    assert.deepEqual(await runScript('fine.sh', 'digest', 't', {}), { ok: true });
    const failed = await runScript('fail.sh', 'digest', 't', {});
    assert.equal(failed.ok, false);
    assert.match(String(failed.error), /exit code 3\): broken/);

    const started = Date.now();
    const result = await runScript('hang.sh', 'digest', 't', {}, 500);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /timed out/);
    assert.ok(Date.now() - started < 5_000, 'the background job does not hold the result up');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    const alive = (() => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      // A killed process nobody reaped yet is a zombie: dead for this purpose.
      const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, 'utf8') : '';
      return !/^\d+ \(.*\) Z/.test(stat);
    })();
    assert.equal(alive, false, 'the process the script started in the background was ended too');
    console.log('ok - a script that times out is ended with everything it started');
  }

  // --- Kept plex.tv tokens: who the watchlist sync asks for, and when a token is dropped ----
  // Servers of their own, so nobody the checks above created or counted is involved.
  {
    const { appConfig, plexTokens } = await import('../db/schema');
    const { encryptSecret } = await import('../server/crypto');
    const addServer = async (slug: string) =>
      (
        await db
          .insert(appConfig)
          .values({ serverType: 'plex', serverUrl: `http://${slug}.test:32400`, serverToken: encryptSecret('admin'), label: slug, slug })
          .returning()
      )[0];
    const [asked, other] = [await addServer('kept-asked'), await addServer('kept-other')];
    const person = async (serverId: number, name: string) =>
      (await db.insert(users).values({ serverId, serverUserId: `kept-${name}`, username: name }).returning())[0];
    const keep = (userId: number, token: string, ageMs: number) =>
      db.insert(plexTokens).values({ userId, token: encryptSecret(token), updatedAt: new Date(Date.now() - ageMs) });
    const keptFor = async (userId: number) =>
      (await db.select().from(plexTokens).where(eq(plexTokens.userId, userId))).length;

    const recent = await person(asked.id, 'recent');
    await keep(recent.id, 'recent-token', day);
    // Every session long expired: the kept token does not depend on one.
    const lapsed = await person(asked.id, 'lapsed');
    await keep(lapsed.id, 'lapsed-token', 60 * day);
    await db.insert(authSessions).values({
      id: session.sessionHandle(randomBytes(32).toString('hex')),
      userId: lapsed.id,
      serverToken: encryptSecret('lapsed-token'),
      createdAt: new Date(Date.now() - 60 * day),
      expiresAt: new Date(Date.now() - 30 * day),
    });
    const empty = await person(asked.id, 'empty');
    await keep(empty.id, '', day);
    const unreadable = await person(asked.id, 'unreadable');
    await db.insert(plexTokens).values({ userId: unreadable.id, token: `${encryptSecret('x').slice(0, -4)}AAAA` });
    const elsewhere = await person(other.id, 'elsewhere');
    await keep(elsewhere.id, 'elsewhere-token', day);

    const kept = await session.keptPlexTokens([asked.id]);
    assert.deepEqual(
      kept.map((k) => [k.user.username, k.token]),
      [
        ['recent', 'recent-token'],
        ['lapsed', 'lapsed-token'],
      ],
      'most recent first, with or without a live session; empty, unreadable and other servers left out',
    );
    assert.deepEqual(await session.keptPlexTokens([]), []);

    // A refused token is dropped; one a sign-in has replaced in the meantime is not.
    await session.dropPlexToken(lapsed.id, 'lapsed-token');
    assert.equal(await keptFor(lapsed.id), 0, 'a refused token is forgotten');
    await session.dropPlexToken(recent.id, 'an-older-token');
    assert.equal(await keptFor(recent.id), 1, 'a newer token than the refused one stays');
    await session.dropPlexToken(unreadable.id, 'whatever');
    assert.equal(await keptFor(unreadable.id), 0, 'an unreadable one goes too');

    // The roster: a kept token alone counts as signed in. Gone from the list: dropped. A changed
    // role keeps it, the person still has access.
    const roster = await addServer('kept-roster');
    const [owner, left, promoted] = await db
      .insert(users)
      .values([
        { serverId: roster.id, serverUserId: 'k-owner', username: 'KeptOwner', isAdmin: true },
        { serverId: roster.id, serverUserId: 'k-left', username: 'KeptLeft', isAdmin: false },
        { serverId: roster.id, serverUserId: 'k-promoted', username: 'KeptPromoted', isAdmin: false },
      ])
      .returning();
    for (const someone of [owner, left, promoted]) await keep(someone.id, `${someone.username}-token`, day);
    const printed = await captured(() =>
      reconcileRoster(roster.id, [
        { serverUserId: 'k-owner', username: 'KeptOwner', isAdmin: true },
        { serverUserId: 'k-promoted', username: 'KeptPromoted', isAdmin: true },
      ]),
    );
    assert.match(printed, /KeptLeft is no longer in the media server's user list/);
    assert.equal(await keptFor(left.id), 0, 'somebody who left the server is no longer asked for');
    assert.equal(await keptFor(promoted.id), 1, 'a changed role keeps the token');
    assert.equal(await keptFor(owner.id), 1);
    console.log('ok - kept plex.tv tokens outlive sessions and go when refused or when the person leaves');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
