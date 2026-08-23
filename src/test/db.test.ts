import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs against a throwaway SQLite file, so no external service is needed.
const dir = mkdtempSync(join(tmpdir(), 'watcharr-test-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.SESSION_SECRET ??= 'test-secret';

execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });
// Running it again must be a no-op rather than a duplicate-table error.
execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });
console.log('ok - migrations are idempotent');

// Migrating a database that already holds rows is a different code path from migrating an
// empty one: SQLite accepts ADD COLUMN with a non-constant DEFAULT only while the table is
// empty. Every check above starts from a fresh file and would never notice, so this walks
// the upgrade path an existing deployment actually takes.
{
  const upgradeDir = mkdtempSync(join(tmpdir(), 'watcharr-upgrade-'));
  const upgradePath = join(upgradeDir, 'upgrade.db');
  const sqlite = new Database(upgradePath);
  sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

  // Bring the database to the state a deployment was in before progress_at existed.
  for (const file of ['0000_spooky_pixie.sql', '0001_add_playback_sessions.sql']) {
    const sql = readFileSync(join('drizzle', file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
  }

  const seenAt = Date.now() - 60_000;
  sqlite
    .prepare(
      'INSERT INTO playback_sessions (session_key, item_id, title, media_type, state, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('legacy', 'lib-1', 'Legacy Session', 'movie', 'ended', seenAt);
  sqlite.close();

  execFileSync('node', ['scripts/migrate.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_PATH: upgradePath },
  });

  const check = new Database(upgradePath, { readonly: true });
  const row = check.prepare('SELECT progress_at FROM playback_sessions WHERE session_key = ?').get('legacy') as {
    progress_at: number;
  };
  assert.equal(row.progress_at, seenAt, 'existing rows are backfilled from last_seen_at');
  check.close();
  rmSync(upgradeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log('ok - migrations apply to a database that already has rows');
}

async function main() {
  const { db, closeDb } = await import('../db');
  const { users, watchHistory } = await import('../db/schema');
  const { decryptSecret, encryptSecret } = await import('../server/crypto');
  const {
    getDailyActivity,
    getPeakHours,
    getStreak,
    getTopGenres,
    getTopTitles,
    getTopTitlesByTime,
    getTotals,
    getUserLeaderboard,
    getHighlights,
    getWeekdayActivity,
  } = await import('../server/stats');
  const { getTitleDetail } = await import('../server/titles');

  const [alice] = await db
    .insert(users)
    .values({ serverUserId: 'u1', username: 'alice' })
    .returning();
  const [bob] = await db.insert(users).values({ serverUserId: 'u2', username: 'bob' }).returning();

  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);

  await db.insert(watchHistory).values([
    { userId: alice.id, itemId: 'm1', title: 'Alien', mediaType: 'movie', year: 1979, genres: ['Sci-Fi', 'Horror'], watchedAt: today, durationMs: 3_600_000 },
    { userId: alice.id, itemId: 'm2', title: 'Aliens', mediaType: 'movie', year: 1986, genres: ['Sci-Fi'], watchedAt: yesterday, durationMs: 7_200_000 },
    { userId: alice.id, itemId: 'e1', title: 'Pilot', grandparentTitle: 'Firefly', mediaType: 'episode', year: 2002, genres: ['Sci-Fi'], watchedAt: today, durationMs: 2_700_000 },
    { userId: bob.id, itemId: 'm3', title: 'Heat', mediaType: 'movie', year: 1995, genres: ['Crime'], watchedAt: today, durationMs: 1_800_000 },
  ]);

  const scope = { userId: alice.id };

  const totals = await getTotals(scope);
  assert.equal(totals.plays, 3);
  assert.equal(totals.movies, 2);
  assert.equal(totals.episodes, 1);
  assert.equal(totals.watchtimeMs, 13_500_000);
  assert.equal(totals.activeDays, 2);
  console.log('ok - getTotals');

  const windowed = await getTotals(scope, 1);
  assert.ok(windowed.plays <= totals.plays, 'the period filter must not widen the result');
  console.log('ok - getTotals with period filter');

  const daily = await getDailyActivity(scope, 7);
  assert.equal(daily.length, 7, 'days without plays must still produce a bucket');
  assert.equal(daily.at(-1)?.value, 105); // 60 + 45 minutes today
  console.log('ok - getDailyActivity');

  const genres = await getTopGenres(scope);
  assert.deepEqual(genres[0], { label: 'Sci-Fi', value: 3 });
  assert.ok(genres.some((g) => g.label === 'Horror'), 'json_each must expand every genre');
  console.log('ok - getTopGenres');

  const titles = await getTopTitles(scope);
  assert.ok(titles.some((t) => t.label === 'Firefly'), 'episodes group under their show');
  console.log('ok - getTopTitles');


  const hours = await getPeakHours(scope);
  assert.equal(hours.length, 24);
  assert.equal(hours.reduce((sum, h) => sum + h.value, 0), 3);
  console.log('ok - getPeakHours');

  assert.equal(await getStreak(scope), 2);
  console.log('ok - getStreak');

  const leaderboard = await getUserLeaderboard();
  assert.equal(leaderboard[0].label, 'alice');
  assert.equal(leaderboard[0].value, 225);
  console.log('ok - getUserLeaderboard');

  // Deleting a user must take their history with it (foreign keys are off by default in SQLite).
  await db.delete(users).where(eq(users.id, bob.id));
  const orphans = await db.select().from(watchHistory).where(eq(watchHistory.userId, bob.id));
  assert.equal(orphans.length, 0, 'cascade delete must remove history rows');
  console.log('ok - foreign keys cascade');

  // Regression: a GROUP BY on the alias `title` resolves to the column instead, which
  // listed a show once per episode rather than aggregating it.
  await db.insert(watchHistory).values(
    [1, 2, 3, 4].map((episode) => ({
      userId: alice.id,
      itemId: `dg-${episode}`,
      title: `Episode ${episode}`,
      grandparentTitle: 'Dark Gathering',
      mediaType: 'episode',
      genres: ['Horror'],
      watchedAt: new Date(Date.now() - episode * 1000),
      durationMs: 1_200_000,
    })),
  );
  const grouped = (await getTopTitles(scope)).filter((t) => t.label === 'Dark Gathering');
  assert.equal(grouped.length, 1, 'a show must appear exactly once');
  assert.equal(grouped[0].value, 4, 'all four episodes must be counted together');
  console.log('ok - getTopTitles groups episodes under one show');

  const byTime = await getTopTitlesByTime(scope);
  assert.equal(byTime.find((t) => t.label === 'Dark Gathering')?.value, 80);
  console.log('ok - getTopTitlesByTime');

  const weekdays = await getWeekdayActivity(scope);
  assert.equal(weekdays.length, 7);
  assert.deepEqual(weekdays.map((w) => w.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  console.log('ok - getWeekdayActivity');

  const highlights = await getHighlights(scope);
  assert.ok(highlights.longestStreak >= 2);
  assert.ok(highlights.averagePlayMs > 0);
  assert.equal(highlights.distinctTitles, 4); // Alien, Aliens, Firefly, Dark Gathering
  console.log('ok - getHighlights');

  const detail = await getTitleDetail('Dark Gathering', scope);
  assert.ok(detail, 'title detail must be found');
  assert.equal(detail.plays, 4);
  assert.equal(detail.distinctItems, 4);
  assert.deepEqual(detail.genres, ['Horror']);
  assert.equal(detail.daily.length, 30);
  assert.equal(await getTitleDetail('Does Not Exist', scope), null);
  console.log('ok - getTitleDetail');

  const { getMonthlyActivity, getWeekHourGrid, getRewatchSplit, getRecords, getTrend } =
    await import('../server/stats');

  const months = await getMonthlyActivity(scope, new Date().getFullYear());
  assert.equal(months.length, 12, 'a year always has twelve buckets');
  console.log('ok - getMonthlyActivity');

  const grid = await getWeekHourGrid(scope);
  assert.equal(grid.length, 7);
  assert.equal(grid[0].length, 24);
  assert.equal(grid.flat().filter((value) => value > 0).length > 0, true);
  console.log('ok - getWeekHourGrid');

  const split = await getRewatchSplit(scope);
  assert.equal(split.fresh + split.rewatch, 7, 'every play is either new or a rewatch');
  console.log('ok - getRewatchSplit');

  const recordsFor = await getRecords(scope);
  assert.equal(recordsFor.bingeCount, 4, 'four Dark Gathering episodes on one day');
  assert.equal(recordsFor.bingeTitle, 'Dark Gathering');
  assert.equal(recordsFor.longestPlayMs, 7_200_000);
  console.log('ok - getRecords');

  assert.equal(await getTrend(scope, 30), null, 'no previous window means no trend');
  console.log('ok - getTrend');

  // Liveness: a session frozen for minutes must not count as playing.
  const { playbackSessions } = await import('../db/schema');
  const { liveSessionFilter } = await import('../server/sync');
  const base = {
    itemId: 'x',
    title: 'Frozen',
    mediaType: 'movie',
    durationMs: 3_600_000,
    userId: alice.id,
  };
  await db.insert(playbackSessions).values([
    { ...base, sessionKey: 'live', state: 'playing', progressMs: 1000, lastSeenAt: new Date(), progressAt: new Date() },
    {
      ...base,
      sessionKey: 'zombie',
      state: 'playing',
      progressMs: 1000,
      lastSeenAt: new Date(),
      progressAt: new Date(Date.now() - 10 * 60_000),
    },
    {
      ...base,
      sessionKey: 'paused',
      state: 'paused',
      progressMs: 1000,
      lastSeenAt: new Date(),
      progressAt: new Date(Date.now() - 10 * 60_000),
    },
  ]);
  const liveKeys = (await db.select().from(playbackSessions).where(liveSessionFilter())).map(
    (row) => row.sessionKey,
  );
  assert.deepEqual(liveKeys.sort(), ['live', 'paused'], 'a stalled session is not live');
  console.log('ok - stalled sessions drop out of live');

  const token = 'plex-token-value';
  const stored = encryptSecret(token);
  assert.notEqual(stored, token, 'tokens must not be stored in clear text');
  assert.equal(decryptSecret(stored), token);
  assert.throws(() => decryptSecret(stored.slice(0, -4) + 'AAAA'), 'tampering must be detected');
  assert.equal(decryptSecret('legacy-plain-value'), 'legacy-plain-value');
  console.log('ok - token encryption');

  // WAL files stay locked on Windows until the handle is closed.
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

void main();
