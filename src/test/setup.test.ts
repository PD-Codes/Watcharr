import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Own throwaway database, set before the db module is imported (it connects on load).
const dir = mkdtempSync(join(tmpdir(), 'watcharr-setup-test-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.SESSION_SECRET ??= 'test-secret';
execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'ignore', env: process.env });

async function main() {
  const { createFirstServer, listServers } = await import('../server/config');
  const { claimGlobalAdmin } = await import('../server/session');
  const { db } = await import('../db');
  const { users } = await import('../db/schema');

  // Only the first setup wins; the second finds a server and creates nothing.
  const input = { serverType: 'jellyfin' as const, serverUrl: 'http://media.test', serverToken: 't', label: 'Main' };
  const first = createFirstServer(input);
  assert.ok(first, 'the first setup creates the server');
  assert.equal(first.slug, 'main');
  assert.equal(first.serverToken, 't', 'and hands the token back decrypted');
  assert.equal(createFirstServer({ ...input, label: 'Other' }), null);
  assert.equal((await listServers()).length, 1);

  // The setup token: printed once while no admin exists, wrong guesses are throttled per
  // address, a correct one (any case, dash optional) is accepted, and it is inert afterwards.
  const { announceSetupToken, checkSetupToken, setupTokenPending } = await import('../server/setuptoken');
  assert.equal(await setupTokenPending(), true);
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(' '));
  await announceSetupToken();
  await announceSetupToken();
  console.log = realLog;
  assert.equal(logged.length, 1, 'the token is announced once');
  const token = logged[0].match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)?.[1];
  assert.ok(token, 'and shown in the console');
  assert.equal(await checkSetupToken('', 'ip-a'), 'none');
  assert.equal(await checkSetupToken('WRONG-TOKEN', 'ip-a'), 'invalid');
  assert.equal(await checkSetupToken(token.toLowerCase().replace('-', ' '), 'ip-b'), 'valid');
  for (let i = 0; i < 8; i += 1) await checkSetupToken('NOPE-NOPE', 'ip-c');
  assert.equal(await checkSetupToken(token, 'ip-c'), 'limited', 'guessing is throttled even for the right token');

  // Two admins signing in at once: exactly one becomes the global admin.
  const rows = await db
    .insert(users)
    .values([
      { serverId: first.id, serverUserId: 'a', username: 'a', isAdmin: true },
      { serverId: first.id, serverUserId: 'b', username: 'b', isAdmin: true },
    ])
    .returning();
  const claims = await Promise.all(rows.map((row) => claimGlobalAdmin(row.id)));
  assert.deepEqual(claims.filter(Boolean).length, 1, 'one claim wins');
  assert.equal((await db.select().from(users)).filter((u) => u.globalAdmin).length, 1);
  assert.equal(await claimGlobalAdmin(rows[0].id), false, 'and nobody can claim it afterwards');

  // Users who never signed in get rows from the media server's lists, matched by id or name.
  const { ensureUsers } = await import('../server/userroster');
  const before = (await db.select().from(users)).length;
  assert.equal(
    await ensureUsers(first.id, [
      { serverUserId: 'a', username: 'renamed' }, // known id
      { serverUserId: '1', username: 'B' }, // known by name (Plex owner: local id 1)
      { serverUserId: 'c', username: 'Carol' },
      { serverUserId: 'c', username: 'Carol' }, // duplicate in the same list
      { serverUserId: 'd', username: 'unknown' }, // placeholder name
    ]),
    1,
  );
  assert.equal((await db.select().from(users)).length, before + 1);
  assert.equal(await ensureUsers(first.id, [{ serverUserId: 'c', username: 'carol' }]), 0, 'and not twice');

  assert.equal(await setupTokenPending(), false);
  assert.equal(await checkSetupToken(token, 'ip-d'), 'none', 'the token is inert once an admin exists');

  console.log('ok - first setup and the global admin claim are single-winner');
}

void main();
