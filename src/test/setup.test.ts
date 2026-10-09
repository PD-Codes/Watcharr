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

  console.log('ok - first setup and the global admin claim are single-winner');
}

void main();
