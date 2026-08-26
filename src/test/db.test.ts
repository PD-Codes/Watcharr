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

  // The multi-server migration has to find an owner for the global admin role and move
  // the deployment settings out of app_config, so both need rows to work with.
  sqlite
    .prepare(
      'INSERT INTO app_config (id, server_type, server_url, server_token, server_name, tmdb_api_key, features, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('jellyfin', 'http://server', 'token', 'Living Room Server', 'tmdb-key', '{"suggestions":false}', Date.now());
  const addUser = sqlite.prepare(
    'INSERT INTO users (server_user_id, username, is_admin, created_at) VALUES (?, ?, ?, ?)',
  );
  addUser.run('srv-viewer', 'viewer', 0, Date.now());
  addUser.run('srv-admin', 'admin', 1, Date.now());
  addUser.run('srv-admin-2', 'admin2', 1, Date.now());
  sqlite.close();

  execFileSync('node', ['scripts/migrate.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_PATH: upgradePath },
  });

  const check = new Database(upgradePath, { readonly: true });
  // Session keys gained a server prefix, because two servers can hand out the same one.
  const row = check
    .prepare('SELECT progress_at FROM playback_sessions WHERE session_key = ?')
    .get('1:legacy') as { progress_at: number };
  assert.equal(row.progress_at, seenAt, 'existing rows are backfilled from last_seen_at');

  const server = check.prepare('SELECT label, slug FROM app_config WHERE id = 1').get() as {
    label: string;
    slug: string;
  };
  assert.equal(server.label, 'Living Room Server', 'the label falls back to the reported name');
  assert.equal(server.slug, 'server-1');

  const settings = check.prepare('SELECT tmdb_api_key, features FROM app_settings WHERE id = 1').get() as {
    tmdb_api_key: string;
    features: string;
  };
  assert.equal(settings.tmdb_api_key, 'tmdb-key', 'the TMDB key moves to app_settings');
  assert.equal(settings.features, '{"suggestions":false}', 'feature toggles move along with it');

  // Exactly one global admin, and it has to be an admin — not simply the first row.
  const admins = check
    .prepare('SELECT username FROM users WHERE global_admin = 1')
    .all() as { username: string }[];
  assert.deepEqual(
    admins.map((u) => u.username),
    ['admin'],
    'the oldest media server admin becomes the global admin',
  );
  const serverIds = check.prepare('SELECT DISTINCT server_id FROM users').all() as {
    server_id: number;
  }[];
  assert.deepEqual(serverIds, [{ server_id: 1 }], 'existing users belong to the first server');
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

  // Concurrency is reconstructed from session intervals, so two sessions that overlap in
  // time have to land in the same hourly bucket even though neither is running any more.
  {
    const { playbackSessions: sessions } = await import('../db/schema');
    const { getConcurrencyOverTime } = await import('../server/playback');
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    await db.insert(sessions).values([
      {
        sessionKey: 'past-a',
        userId: alice.id,
        itemId: 'a',
        title: 'A',
        mediaType: 'movie',
        state: 'ended',
        playMethod: 'directplay',
        isLocal: true,
        bitrateKbps: 3000,
        progressMs: 60 * 60_000,
        durationMs: 90 * 60_000,
        startedAt: minutesAgo(90),
        lastSeenAt: minutesAgo(30),
        progressAt: minutesAgo(30),
      },
      {
        sessionKey: 'past-b',
        userId: alice.id,
        itemId: 'b',
        title: 'B',
        mediaType: 'movie',
        state: 'ended',
        playMethod: 'transcode',
        isLocal: false,
        videoCodec: 'h264',
        height: 720,
        sourceVideoCodec: 'hevc',
        sourceHeight: 2160,
        bitrateKbps: 5000,
        progressMs: 40 * 60_000,
        durationMs: 40 * 60_000,
        startedAt: minutesAgo(80),
        lastSeenAt: minutesAgo(40),
        progressAt: minutesAgo(40),
      },
    ]);

    // The watched threshold is applied on read, so the same rows must reclassify when it
    // moves. past-a finished 60 of 90 minutes (66%), past-b 40 of 40 (100%).
    const { getCompletionSplit } = await import('../server/playback');
    const strict = await getCompletionSplit(85);
    assert.deepEqual(
      { finished: strict.finished, abandoned: strict.abandoned, rate: strict.rate },
      { finished: 1, abandoned: 1, rate: 50 },
    );
    const lenient = await getCompletionSplit(60);
    assert.equal(lenient.finished, 2, 'a lower threshold reclassifies the same rows');
    assert.equal(lenient.rate, 100);
    console.log('ok - getCompletionSplit follows the threshold');

    const series = await getConcurrencyOverTime(1);
    assert.ok(series.length >= 24, 'a day of hourly buckets');
    assert.equal(new Set(series.map((p) => p.label)).size, series.length, 'buckets are distinct');
    const busiest = series.reduce((best, p) => (p.streams > best.streams ? p : best), series[0]);
    assert.equal(busiest.streams, 2, 'both overlapping sessions fall into one bucket');
    assert.equal(busiest.bandwidthKbps, 8000, 'bandwidth is summed per bucket');
    console.log('ok - getConcurrencyOverTime');

    // Bandwidth is only actionable split by where it went: past-a is a LAN stream, past-b
    // a remote one, and summing them would hide the half that costs uplink.
    const { getBandwidthOverTime, getStreamTypesOverTime, listSessionHistory } = await import(
      '../server/playback'
    );
    const bandwidth = await getBandwidthOverTime(1);
    // Summed across buckets rather than asserted on one: the sessions are 90 minutes old,
    // so which hourly bucket they land in depends on when the suite runs.
    assert.equal(
      Math.max(...bandwidth.map((p) => p.lanKbps)),
      3000,
      'the local session counts as LAN only',
    );
    assert.equal(
      Math.max(...bandwidth.map((p) => p.wanKbps)),
      5000,
      'the remote session counts as WAN only',
    );
    console.log('ok - getBandwidthOverTime splits LAN from remote');

    const types = await getStreamTypesOverTime(2);
    const totalPer = (label: string) =>
      types.series.find((serie) => serie.label === label)?.values.reduce((a, b) => a + b, 0) ?? 0;
    assert.equal(types.labels.length, 2, 'one bucket per day in the range');
    assert.equal(totalPer('Direct play'), 1);
    assert.equal(totalPer('Transcode'), 1);
    assert.equal(totalPer('Direct stream'), 0);
    console.log('ok - getStreamTypesOverTime counts each delivery method');

    const all = await listSessionHistory({ limit: 10 });
    assert.equal(all.total, 2);
    // past-b started ten minutes after past-a, so it heads the list.
    assert.equal(all.rows[0].sessionKey, 'past-b', 'newest session first');
    const transcodes = await listSessionHistory({ limit: 10, transcodesOnly: true });
    assert.equal(transcodes.total, 1);
    // Both halves survive the round trip, which is what the stream table renders as an arrow.
    assert.deepEqual(
      {
        source: [transcodes.rows[0].sourceVideoCodec, transcodes.rows[0].sourceHeight],
        delivered: [transcodes.rows[0].videoCodec, transcodes.rows[0].height],
      },
      { source: ['hevc', 2160], delivered: ['h264', 720] },
    );
    console.log('ok - listSessionHistory keeps both sides of a transcode');
  }

  // The play-count aggregates, which answer a different question from the watch-time ones:
  // an evening of short episodes wins on count and loses on time. Own user and own rows:
  // the checks above keep adding to alice's history, so an absolute count over her would
  // change every time one of them grows.
  {
    const { getDailyPlays, getWeekdayPlays, getPlaysByMediaType, getPlaysByUser } = await import(
      '../server/stats'
    );
    const [carol] = await db
      .insert(users)
      .values({ serverUserId: 'u3', username: 'carol' })
      .returning();
    const carolScope = { userId: carol.id };
    await db.insert(watchHistory).values([
      { userId: carol.id, itemId: 'c1', title: 'Dune', mediaType: 'movie', genres: [], watchedAt: today, durationMs: 9_000_000 },
      { userId: carol.id, itemId: 'c2', title: 'Ep 1', grandparentTitle: 'Severance', mediaType: 'episode', genres: [], watchedAt: today, durationMs: 2_400_000 },
      { userId: carol.id, itemId: 'c3', title: 'Ep 2', grandparentTitle: 'Severance', mediaType: 'episode', genres: [], watchedAt: yesterday, durationMs: 2_400_000 },
    ]);

    const daily = await getDailyPlays(carolScope, 2);
    assert.equal(daily.length, 2, 'one bucket per day, empty days included');
    assert.deepEqual(
      daily.map((d) => d.value),
      [1, 2],
      'yesterday one play, today two',
    );

    const weekday = await getWeekdayPlays(carolScope);
    assert.equal(weekday.length, 7);
    assert.equal(weekday[0].label, 'Mon', 'the week starts on Monday, unlike strftime');
    assert.equal(
      weekday.reduce((sum, d) => sum + d.value, 0),
      3,
    );

    const byType = await getPlaysByMediaType(carolScope);
    assert.deepEqual(Object.fromEntries(byType.map((d) => [d.label, d.value])), {
      episode: 2,
      movie: 1,
    });

    // Server-wide by design, so it is read by name rather than by position.
    const byUser = await getPlaysByUser();
    assert.equal(byUser.find((d) => d.label === 'carol')?.value, 3);
    console.log('ok - play-count aggregates');
  }

  // An item that is playing right now has a session row and no history row at all. Linking
  // to it from Now Playing used to answer 404, because the detail view only ever looked at
  // the history.
  {
    const { getItemDetail } = await import('../server/titles');
    const { playbackSessions: live } = await import('../db/schema');
    await db.insert(live).values({
      sessionKey: 'live-1',
      userId: alice.id,
      itemId: 'never-played',
      title: 'The Constant',
      grandparentTitle: 'Lost',
      mediaType: 'episode',
      state: 'playing',
      deviceName: 'Living Room',
      progressMs: 5 * 60_000,
      durationMs: 45 * 60_000,
    });

    const detail = await getItemDetail('never-played', { userId: alice.id });
    assert.ok(detail, 'a running item resolves even without a history row');
    assert.equal(detail.title, 'The Constant');
    assert.equal(detail.showLabel, 'Lost');
    assert.equal(detail.plays, 0, 'the media server has not counted it as played yet');
    assert.deepEqual(detail.devices, [{ label: 'Living Room', value: 5 }]);

    assert.equal(
      await getItemDetail('no-such-item', { userId: alice.id }),
      null,
      'a genuinely unknown item is still a 404',
    );
    // Removed again: the liveness check further down asserts an exact list of live
    // sessions, and a second playing row would join it.
    await db.delete(live).where(eq(live.sessionKey, 'live-1'));
    console.log('ok - a playing item resolves before it reaches the history');
  }

  // A successful login from an address the account has never used. The failed-login check
  // cannot see this at all: someone who knows the password never fails.
  {
    const { loginHistory } = await import('../db/schema');
    const { updateSettings } = await import('../server/config');
    const { checkThresholds, listAlerts } = await import('../server/monitor');

    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    await updateSettings({ monitorNewAddressAlert: true, monitorFailedLoginWindowMin: 10 });
    await db.insert(loginHistory).values([
      // A device alice has used before, seen again just now: familiar, must stay silent.
      { userId: alice.id, username: 'alice', success: true, ip: '10.0.0.5', createdAt: minutesAgo(600) },
      { userId: alice.id, username: 'alice', success: true, ip: '10.0.0.5', createdAt: minutesAgo(1) },
      // Never seen before.
      { userId: alice.id, username: 'alice', success: true, ip: '203.0.113.9', createdAt: minutesAgo(1) },
    ]);

    await checkThresholds();
    const alerts = (await listAlerts(10)).filter((a) => a.rule === 'new_address');
    assert.equal(alerts.length, 1, 'only the unknown address alerts');
    assert.match(alerts[0].message, /203\.0\.113\.9/);
    assert.ok(!alerts[0].message.includes('10.0.0.5'), 'a known address stays quiet');
    await updateSettings({ monitorNewAddressAlert: false });
    console.log('ok - a login from an unknown address alerts, a known one does not');
  }

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
