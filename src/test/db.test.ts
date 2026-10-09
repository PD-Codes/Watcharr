import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
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

  // A server admin's scope is "everything on my server". The title page used to filter only
  // by the label, so the same title watched on another server leaked its plays and viewer.
  {
    const [onServer1] = await db
      .insert(users)
      .values({ serverId: 1, serverUserId: 'scope-1', username: 'scope-one' })
      .returning();
    const [onServer2] = await db
      .insert(users)
      .values({ serverId: 2, serverUserId: 'scope-2', username: 'scope-two' })
      .returning();
    for (const user of [onServer1, onServer2]) {
      await db.insert(watchHistory).values({
        userId: user.id,
        itemId: `scope-${user.id}`,
        title: 'Scoped Title',
        mediaType: 'movie',
        genres: [],
        watchedAt: today,
        durationMs: 3_600_000,
      });
    }
    const own = await getTitleDetail('Scoped Title', { userId: null, serverId: 1 });
    assert.equal(own?.plays, 1, 'another server\'s plays stay out of a server-scoped title');
    assert.deepEqual(own?.viewers.map((v) => v.label), ['scope-one']);
    assert.equal((await getTitleDetail('Scoped Title', { userId: null }))?.plays, 2);
    await db.delete(users).where(eq(users.id, onServer1.id));
    await db.delete(users).where(eq(users.id, onServer2.id));
    console.log('ok - getTitleDetail respects the server scope');
  }

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
    // Bucketed in the app timezone like every other aggregate, so the newest bucket is the
    // current local hour. UTC buckets put a Berlin evening on the wrong hour.
    const clock = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    assert.equal(
      series.at(-1)?.label,
      `${two(clock.getMonth() + 1)}-${two(clock.getDate())} ${two(clock.getHours())}:00`,
      'bucket labels follow the process timezone',
    );
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

    // Two sessions first seen in one poll share started_at. Each used to be joined to the whole
    // overlap set, so the peak read four times what was actually playing.
    const { getConcurrencyPeak } = await import('../server/playback');
    const sameInstant = minutesAgo(70);
    await db.insert(sessions).values(
      ['twin-a', 'twin-b'].map((sessionKey) => ({
        sessionKey,
        userId: alice.id,
        itemId: sessionKey,
        title: sessionKey,
        mediaType: 'movie',
        state: 'ended',
        playMethod: 'directplay',
        startedAt: sameInstant,
        lastSeenAt: minutesAgo(60),
        progressAt: minutesAgo(60),
      })),
    );
    // At that instant past-a, past-b and both twins are playing: four, not eight.
    assert.equal((await getConcurrencyPeak(1)).streams, 4);
    await db.delete(sessions).where(inArray(sessions.sessionKey, ['twin-a', 'twin-b']));
    console.log('ok - getConcurrencyPeak counts sessions sharing a start once');
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

  // The same name on two servers is two accounts. Counting streams by name added them up and
  // alerted on a limit neither account had crossed.
  {
    const { playbackSessions: live } = await import('../db/schema');
    const { updateSettings } = await import('../server/config');
    const { checkThresholds, listAlerts } = await import('../server/monitor');

    const [twinOne] = await db
      .insert(users)
      .values({ serverId: 1, serverUserId: 'twin-1', username: 'twin' })
      .returning();
    const [twinTwo] = await db
      .insert(users)
      .values({ serverId: 2, serverUserId: 'twin-2', username: 'twin' })
      .returning();
    const stream = (sessionKey: string, userId: number) => ({
      sessionKey,
      userId,
      itemId: sessionKey,
      title: sessionKey,
      mediaType: 'movie',
      state: 'playing',
      progressMs: 1000,
      durationMs: 3_600_000,
      lastSeenAt: new Date(),
      progressAt: new Date(),
    });
    await updateSettings({ monitorMaxStreamsPerUser: 1 });
    await db.insert(live).values([stream('twin-a', twinOne.id), stream('twin-b', twinTwo.id)]);
    const streamAlerts = async () =>
      (await listAlerts(50)).filter((a) => a.rule === 'max_streams_per_user').length;

    await checkThresholds();
    assert.equal(await streamAlerts(), 0, 'one stream each is within the limit of one');
    await db.insert(live).values(stream('twin-c', twinOne.id));
    await checkThresholds();
    assert.equal(await streamAlerts(), 1, 'two streams on one account still alert');

    await updateSettings({ monitorMaxStreamsPerUser: 0 });
    await db.delete(live).where(inArray(live.sessionKey, ['twin-a', 'twin-b', 'twin-c']));
    await db.delete(users).where(inArray(users.id, [twinOne.id, twinTwo.id]));
    console.log('ok - stream limits count per account, not per name');
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
    {
      // Paused days ago and still reported by the server: an abandoned tab, not a stream.
      ...base,
      sessionKey: 'abandoned',
      state: 'paused',
      progressMs: 1000,
      lastSeenAt: new Date(),
      progressAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
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

  // Three writers now share watch_history and describe the same evening differently. The
  // unique index only catches an identical timestamp, so this is the check that one film
  // watched once stays one row — and that the metadata still lands on it.
  {
    const { recordPlays } = await import('../server/plays');
    const { watchHistory } = await import('../db/schema');
    const [viewer] = await db
      .insert(users)
      .values({ serverId: 1, serverUserId: 'dedupe-1', username: 'dedupe' })
      .returning();
    const at = new Date('2024-05-01T20:00:00Z');

    const first = await recordPlays(
      viewer.id,
      [{ itemId: 'film-1', title: 'Arrival', mediaType: 'movie', watchedAt: at, durationMs: 6_000_000 }],
      'session',
    );
    assert.equal(first, 1, 'a finished stream is recorded');

    // The media server marks the same film played a few minutes later, with the genres a
    // session never carries.
    const second = await recordPlays(
      viewer.id,
      [
        {
          itemId: 'film-1',
          title: 'Arrival',
          mediaType: 'movie',
          year: 2016,
          genres: ['Sci-Fi'],
          watchedAt: new Date(at.getTime() + 7 * 60_000),
          durationMs: 6_600_000,
        },
      ],
      'server',
    );
    assert.equal(second, 0, 'the same play from the other writer is not a second row');

    const rows = await db
      .select()
      .from(watchHistory)
      .where(eq(watchHistory.userId, viewer.id));
    assert.equal(rows.length, 1, 'one play, one row');
    assert.deepEqual(rows[0].genres, ['Sci-Fi'], 'the later metadata fills the session row in');
    assert.equal(rows[0].year, 2016);

    // A week later is a rewatch, not the same evening.
    const third = await recordPlays(
      viewer.id,
      [
        {
          itemId: 'film-1',
          title: 'Arrival',
          mediaType: 'movie',
          watchedAt: new Date(at.getTime() + 7 * 86_400_000),
          durationMs: 6_000_000,
        },
      ],
      'server',
    );
    assert.equal(third, 1, 'a rewatch is its own play');
    console.log('ok - one play stays one row across all three writers');
  }

  // Retention deletes rows people cannot get back, so the check is that it deletes exactly
  // what is past its cutoff and leaves a live stream alone whatever its age.
  {
    const { prune } = await import('../server/retention');
    const { updateSettings } = await import('../server/config');
    const { loginHistory, playbackSessions: sessions } = await import('../db/schema');
    const old = new Date(Date.now() - 100 * 86_400_000);

    await db.insert(loginHistory).values([
      { username: 'old', success: true, createdAt: old },
      { username: 'recent', success: true, createdAt: new Date() },
    ]);
    await db.insert(sessions).values({
      sessionKey: 'ancient-but-live',
      itemId: 'x',
      title: 'Still going',
      mediaType: 'movie',
      state: 'playing',
      startedAt: old,
      lastSeenAt: new Date(),
      progressAt: new Date(),
    });

    await updateSettings({ retentionLogDays: 30, retentionSessionDays: 30 });
    await prune();

    const logins = (await db.select().from(loginHistory)).map((row) => row.username);
    assert.ok(!logins.includes('old'), 'the row past the cutoff goes');
    assert.ok(logins.includes('recent'), 'a row inside the window stays');
    const stillThere = await db.select().from(sessions).where(eq(sessions.sessionKey, 'ancient-but-live'));
    assert.equal(stillThere.length, 1, 'a running stream is never pruned, however old');
    await updateSettings({ retentionLogDays: null, retentionSessionDays: null });
    console.log('ok - retention deletes past the cutoff and nothing that is still running');
  }

  // NaN and Infinity must not reach a NOT NULL column (a clamped setting keeps its value) or
  // turn a nullable limit into Infinity (it reads as "off").
  {
    const { updateSettings, getSettings } = await import('../server/config');
    await updateSettings({ backupRetention: 7, watchedThreshold: 70 });
    await updateSettings({
      backupRetention: Number.NaN,
      watchedThreshold: Number.POSITIVE_INFINITY,
      monitorMaxStreamsPerUser: Number.POSITIVE_INFINITY,
      retentionLogDays: Number.NaN,
    });
    const settings = await getSettings();
    assert.equal(settings.backupRetention, 7);
    assert.equal(settings.watchedThreshold, 70);
    assert.equal(settings.monitorMaxStreamsPerUser, null);
    assert.equal(settings.retentionLogDays, null);
    console.log('ok - non-finite settings are ignored, not stored');
  }

  // The import reads somebody else's schema, which is the part that cannot be checked by
  // reading this repository — so it runs against a database shaped like Tautulli's.
  {
    const { importFromTautulli } = await import('../server/tautulli');
    const source = join(dir, 'tautulli.db');
    const tautulli = new Database(source);
    tautulli.exec(`
      CREATE TABLE session_history (
        id INTEGER PRIMARY KEY, started INTEGER, stopped INTEGER, user TEXT,
        rating_key TEXT, media_type TEXT, platform TEXT, player TEXT, ip_address TEXT);
      CREATE TABLE session_history_metadata (
        id INTEGER PRIMARY KEY, title TEXT, grandparent_title TEXT, year INTEGER,
        genres TEXT, duration INTEGER);
      CREATE TABLE session_history_media_info (
        id INTEGER PRIMARY KEY, transcode_decision TEXT, container TEXT, video_codec TEXT,
        audio_codec TEXT, height INTEGER, bitrate INTEGER, transcode_container TEXT,
        transcode_video_codec TEXT, transcode_audio_codec TEXT, transcode_height INTEGER);
    `);
    const started = Math.floor(Date.now() / 1000) - 3600;
    tautulli
      .prepare('INSERT INTO session_history VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(started, started + 5400, 'importer', 'rk-9', 'movie', 'Chrome', 'Desktop', '10.0.0.5');
    // A second row for a user this deployment does not know, which must be reported rather
    // than filed under somebody else.
    tautulli
      .prepare('INSERT INTO session_history VALUES (2, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(started, started + 60, 'a-stranger', 'rk-8', 'movie', 'Chrome', 'Desktop', '10.0.0.6');
    tautulli
      .prepare('INSERT INTO session_history_metadata VALUES (1, ?, NULL, ?, ?, ?)')
      .run('Dune', 2021, 'Sci-Fi;Adventure', 9_000_000);
    tautulli
      .prepare('INSERT INTO session_history_media_info VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('transcode', 'mkv', 'hevc', 'truehd', 2160, 40_000, 'mp4', 'h264', 'aac', 1080);
    tautulli.close();

    await db
      .insert(users)
      .values({ serverId: 1, serverUserId: 'imp-1', username: 'importer' });

    const preview = await importFromTautulli(source, 1, { dryRun: true });
    assert.equal(preview.plays, 1, 'only rows belonging to a known account are imported');
    assert.deepEqual(preview.unmatchedUsers, ['a-stranger'], 'unknown names are reported, not guessed');

    const result = await importFromTautulli(source, 1);
    assert.equal(result.plays, 1);
    assert.equal(result.streams, 1);

    const { watchHistory: history } = await import('../db/schema');
    const [play] = await db.select().from(history).where(eq(history.itemId, 'rk-9'));
    assert.equal(play.title, 'Dune');
    assert.deepEqual(play.genres, ['Sci-Fi', 'Adventure'], 'a semicolon list is still a list');
    assert.equal(play.durationMs, 5_400_000, 'watch time is what was watched, not the runtime');
    assert.equal(play.source, 'tautulli');

    // Running it twice must not double anything — the same guarantee as the two live writers.
    const again = await importFromTautulli(source, 1);
    assert.equal(again.plays, 0, 'a second import adds nothing');
    console.log('ok - a Tautulli database imports once and only once');

    // Newer schemas carry paused_counter (seconds), and a play Tautulli never closed has
    // stopped = 0: pauses must come off the watch time and 0 must not mean 1970.
    const pausedSource = join(dir, 'tautulli-paused.db');
    const modern = new Database(pausedSource);
    modern.exec(`
      CREATE TABLE session_history (
        id INTEGER PRIMARY KEY, started INTEGER, stopped INTEGER, paused_counter INTEGER,
        user TEXT, rating_key TEXT, media_type TEXT, platform TEXT, player TEXT, ip_address TEXT);
      CREATE TABLE session_history_metadata (
        id INTEGER PRIMARY KEY, title TEXT, grandparent_title TEXT, year INTEGER,
        genres TEXT, duration INTEGER);
    `);
    const insertPlay = modern.prepare(
      'INSERT INTO session_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertPlay.run(1, started, started + 3600, 600, 'pauser', 'rk-p1', 'movie', 'Chrome', 'Desktop', '10.0.0.7');
    insertPlay.run(2, started, 0, 0, 'pauser', 'rk-p2', 'movie', 'Chrome', 'Desktop', '10.0.0.7');
    modern.close();
    await db.insert(users).values({ serverId: 1, serverUserId: 'imp-2', username: 'pauser' });
    await importFromTautulli(pausedSource, 1);
    const [paused] = await db.select().from(history).where(eq(history.itemId, 'rk-p1'));
    assert.equal(paused.durationMs, 3_000_000, 'paused time is not watch time');
    const [unclosed] = await db.select().from(history).where(eq(history.itemId, 'rk-p2'));
    assert.equal(unclosed.durationMs, 0);
    assert.equal(unclosed.watchedAt.getTime(), started * 1000, 'stopped = 0 keeps the real start');
    console.log('ok - Tautulli pauses are subtracted and an unclosed play stays dated');
  }

  // --- Behaviors added in the second pass ---------------------------------------------------

  // Process-wide state is looked up by key and created once, whatever the value is. A falsy
  // initial value must not be created again on the next lookup.
  {
    const { globalState } = await import('../server/state');
    let created = 0;
    const first = globalState('test.flag', () => (created += 1, false));
    const second = globalState('test.flag', () => (created += 1, true));
    assert.equal(created, 1, 'init runs once per key');
    assert.equal(first, false);
    assert.equal(second, false, 'the first value wins, even a falsy one');
    const map = globalState('test.map', () => new Map<string, number>());
    map.set('a', 1);
    assert.equal(globalState('test.map', () => new Map<string, number>()).get('a'), 1);
    console.log('ok - globalState hands out one value per key');
  }

  const two = (n: number) => String(n).padStart(2, '0');
  const localDay = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  };
  const at = (offset: number, hour: number, minute = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, hour, minute);
  };

  // Daily series: one grouped scan joined to the calendar. The late-evening and just-after-
  // midnight plays must land on different local days, a day without plays is zero, and rows
  // outside the window (older, or in the future) stay out.
  const [dayUser] = await db.insert(users).values({ serverId: 7, serverUserId: 'day-1', username: 'day-one' }).returning();
  const [dayOther] = await db.insert(users).values({ serverId: 8, serverUserId: 'day-2', username: 'day-two' }).returning();
  await db.insert(watchHistory).values([
    { userId: dayUser.id, itemId: 'd1', title: 'D1', mediaType: 'movie', genres: [], watchedAt: at(-2, 23, 30), durationMs: 3_600_000 },
    { userId: dayUser.id, itemId: 'd2', title: 'D2', mediaType: 'movie', genres: [], watchedAt: at(-1, 0, 30), durationMs: 7_200_000 },
    { userId: dayUser.id, itemId: 'd3', title: 'D3', mediaType: 'movie', genres: [], watchedAt: at(-4, 12), durationMs: 600_000 },
    { userId: dayUser.id, itemId: 'd4', title: 'D4', mediaType: 'movie', genres: [], watchedAt: at(3, 12), durationMs: 600_000 },
    { userId: dayOther.id, itemId: 'd5', title: 'D5', mediaType: 'movie', genres: [], watchedAt: at(-1, 12), durationMs: 1_800_000 },
  ]);
  {
    const { getDailyActivity, getDailyPlays } = await import('../server/stats');
    const labels = [localDay(-2), localDay(-1), localDay(0)];
    const own = { userId: dayUser.id };
    assert.deepEqual(await getDailyActivity(own, 3), labels.map((label, i) => ({ label, value: [60, 120, 0][i] })));
    assert.deepEqual(await getDailyPlays(own, 3), labels.map((label, i) => ({ label, value: [1, 1, 0][i] })));
    assert.deepEqual((await getDailyPlays({ userId: null, serverId: 7 }, 3)).map((p) => p.value), [1, 1, 0]);
    assert.deepEqual((await getDailyPlays({ userId: null, serverId: 8 }, 3)).map((p) => p.value), [0, 1, 0]);
    assert.equal((await getDailyPlays(own, 365)).length, 365);
    console.log('ok - daily series bucket by local day and respect the scope');
  }

  // System page counts follow the admin's scope instead of the whole database.
  {
    const { playbackSessions: sessionRows } = await import('../db/schema');
    const { getSystemCounts } = await import('../server/stats');
    await db.insert(sessionRows).values([
      { sessionKey: '7:sys-a', userId: dayUser.id, itemId: 'x', title: 'X', mediaType: 'movie', state: 'playing', progressMs: 1000, durationMs: 3_600_000, startedAt: new Date(), lastSeenAt: new Date(), progressAt: new Date() },
      { sessionKey: '8:sys-b', userId: dayOther.id, itemId: 'y', title: 'Y', mediaType: 'movie', state: 'ended', progressMs: 3_600_000, durationMs: 3_600_000, startedAt: new Date(), lastSeenAt: new Date(), progressAt: new Date() },
    ]);
    const seven = await getSystemCounts({ userId: null, serverId: 7 });
    const eight = await getSystemCounts({ userId: null, serverId: 8 });
    const all = await getSystemCounts({ userId: null });
    assert.deepEqual({ ...seven, lastPlay: null }, { history: 4, sessions: 1, activity: 1, lastPlay: null });
    assert.deepEqual(eight, { history: 1, sessions: 1, activity: 0, lastPlay: at(-1, 12).getTime() });
    assert.ok(all.history > seven.history + eight.history, 'the unscoped count still sees every server');

    // Completion: the open stream at 0% has neither finished nor been abandoned.
    const { getCompletionSplit } = await import('../server/playback');
    const split = await getCompletionSplit(85, undefined, { userId: dayUser.id });
    assert.deepEqual({ finished: split.finished, abandoned: split.abandoned, rate: split.rate }, { finished: 0, abandoned: 0, rate: null });
    const done = await getCompletionSplit(85, undefined, { userId: dayOther.id });
    assert.deepEqual({ finished: done.finished, abandoned: done.abandoned }, { finished: 1, abandoned: 0 });
    await db.delete(sessionRows).where(inArray(sessionRows.sessionKey, ['7:sys-a', '8:sys-b']));
    console.log('ok - system counts are scoped and open streams are not abandoned');
  }

  // The history filters: a value that is not one of the offered periods, or not a real day,
  // is ignored instead of emptying the list.
  {
    const { historyFilters } = await import('../server/history');
    const [histUser] = await db.insert(users).values({ serverId: 9, serverUserId: 'hist-1', username: 'hist' }).returning();
    await db.insert(watchHistory).values([
      { userId: histUser.id, itemId: 'h1', title: 'H1', mediaType: 'movie', genres: [], watchedAt: at(-2, 12), durationMs: 1000 },
      { userId: histUser.id, itemId: 'h2', title: 'H2', mediaType: 'movie', genres: [], watchedAt: at(-100, 12), durationMs: 1000 },
    ]);
    const count = async (params: Parameters<typeof historyFilters>[1]) =>
      (await db.select().from(watchHistory).where(historyFilters(histUser.id, params))).length;
    assert.equal(await count({}), 2);
    for (const days of ['1e9', 'abc', '-5', '0', '14', '']) {
      assert.equal(await count({ days }), 2, `days=${days} falls back to all time`);
    }
    assert.equal(await count({ days: '7' }), 1);
    assert.equal(await count({ days: '365' }), 2);
    assert.equal(await count({ date: '2026-02-30' }), 2, 'an impossible day is ignored');
    assert.equal(await count({ date: localDay(-2) }), 1);
    console.log('ok - history filters whitelist the period and the day');
  }

  // The server-list high-water mark only moves with rows the server list wrote.
  {
    const { lastServerPlayAt, recordPlays } = await import('../server/plays');
    const [markUser] = await db.insert(users).values({ serverId: 9, serverUserId: 'mark-1', username: 'mark' }).returning();
    const play = (itemId: string, watchedAt: Date) => ({ itemId, title: itemId, mediaType: 'movie', watchedAt, durationMs: 1000 });
    assert.equal(await lastServerPlayAt(markUser.id), undefined);
    await recordPlays(markUser.id, [play('live', at(0, 1))], 'session');
    await recordPlays(markUser.id, [play('imported', at(0, 2))], 'tautulli');
    assert.equal(await lastServerPlayAt(markUser.id), undefined, 'no server row yet: fetch everything');
    await recordPlays(markUser.id, [play('older', at(-5, 20))], 'server');
    assert.equal((await lastServerPlayAt(markUser.id))?.getTime(), at(-5, 20).getTime());
    console.log('ok - the history high-water mark ignores session and import rows');
  }

  // A streak is not capped: 450 consecutive days read as 450.
  {
    const { getStreak } = await import('../server/stats');
    const [streakUser] = await db.insert(users).values({ serverId: 9, serverUserId: 'long-1', username: 'long' }).returning();
    const rows = Array.from({ length: 450 }, (_, i) => ({
      userId: streakUser.id, itemId: `s${i}`, title: `S${i}`, mediaType: 'movie', genres: [] as string[],
      watchedAt: at(-i, 12), durationMs: 1000,
    }));
    for (let i = 0; i < rows.length; i += 150) await db.insert(watchHistory).values(rows.slice(i, i + 150));
    assert.equal(await getStreak({ userId: streakUser.id }), 450);
    console.log('ok - getStreak counts past 400 days');
  }

  // Newsletter libraries are `<serverId>:<sectionId>` keys. Two servers with the same section id
  // must not be mixed up, and ids saved before the key existed keep their old meaning.
  {
    const { normalizeLibraries, sectionsForServer, collectNewsletter } = await import('../server/newsletter');
    assert.deepEqual(normalizeLibraries(['1:a', '2:b', '1:a', ''], [1, 2]), ['1:a', '2:b']);
    assert.deepEqual(normalizeLibraries(['abc'], [1, 2]), ['1:abc', '2:abc'], 'a bare id applies to every server, as it did');
    assert.deepEqual(sectionsForServer([], 1), [], 'nothing selected means everything');
    assert.deepEqual(sectionsForServer(['1:a', '2:b', '1:c:d'], 1), ['a', 'c:d']);
    assert.equal(sectionsForServer(['2:b'], 1), null, 'a server without a selected library is left out');
    assert.equal(sectionsForServer(['12:b'], 1), null, 'server 1 is not server 12');

    const { createServer: createHttp } = await import('node:http');
    const { createServer: addServer, updateSettings: save } = await import('../server/config');
    const { appConfig } = await import('../db/schema');
    const asked: string[] = [];
    const stub = createHttp((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      asked.push(`${url.pathname.split('/')[1]}:${url.searchParams.get('ParentId') ?? ''}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Items: [{ Id: 'n1', Name: 'New', Type: 'Movie', DateCreated: new Date().toISOString() }] }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
    const one = await addServer({ serverType: 'jellyfin', serverUrl: `${base}/s1`, serverToken: 't', label: 'NL One' });
    const two2 = await addServer({ serverType: 'jellyfin', serverUrl: `${base}/s2`, serverToken: 't', label: 'NL Two' });
    const run = async (libraries: string[]) => {
      asked.length = 0;
      await save({ newsletterLibraries: libraries, newsletterDays: 7 });
      const entries = await collectNewsletter();
      return { asked: [...asked].sort(), servers: entries.map((e) => e.serverLabel).sort() };
    };
    assert.deepEqual(await run([]), { asked: ['s1:', 's2:'], servers: ['NL One', 'NL Two'] });
    assert.deepEqual(await run(['lib']), { asked: ['s1:lib', 's2:lib'], servers: ['NL One', 'NL Two'] }, 'legacy id reaches both servers');
    assert.deepEqual(await run([`${one.id}:lib`]), { asked: ['s1:lib'], servers: ['NL One'] });
    assert.deepEqual(
      await run([`${one.id}:libA`, `${two2.id}:libB`]),
      { asked: ['s1:libA', 's2:libB'], servers: ['NL One', 'NL Two'] },
      'each server only gets its own library ids',
    );
    await save({ newsletterLibraries: [] });
    await db.delete(appConfig).where(inArray(appConfig.id, [one.id, two2.id]));
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    console.log('ok - newsletter libraries are per server');
  }

  for (const user of await db.select().from(users).where(inArray(users.serverId, [7, 8, 9]))) {
    await db.delete(users).where(eq(users.id, user.id));
  }

  // The scheduled jobs run from every sync pass, and passes overlap. The in-flight guards live in
  // shared state: a busy flag keeps a second pass out, and a failed backup is not retried at once.
  {
    const { existsSync, readdirSync, writeFileSync, rmSync: remove } = await import('node:fs');
    const { checkAutoBackup } = await import('../server/autobackup');
    const { checkNewsletter } = await import('../server/newsletter');
    const { globalState } = await import('../server/state');
    const { getSettings, updateSettings: save } = await import('../server/config');
    const backups = join(dir, 'backups');
    await save({ backupAutoEnabled: true, backupIntervalHours: 24 });

    const backupGuard = globalState('autobackup', () => ({ busy: false, retryAt: 0 }));
    backupGuard.busy = true;
    await checkAutoBackup();
    assert.equal(existsSync(backups), false, 'a pass that finds a backup running does nothing');
    backupGuard.busy = false;
    backupGuard.retryAt = Date.now() + 60_000;
    await checkAutoBackup();
    assert.equal(existsSync(backups), false, 'a recent failure holds the retry back');
    backupGuard.retryAt = 0;

    // A path that cannot become a directory: the run fails, throws, and arms the retry delay.
    writeFileSync(backups, 'not a directory');
    await assert.rejects(checkAutoBackup());
    assert.ok(backupGuard.retryAt > Date.now(), 'a failed backup is retried later, not on the next poll');
    assert.equal(backupGuard.busy, false, 'the flag is released after a failure');
    await checkAutoBackup(); // inside the delay: returns quietly instead of failing again
    remove(backups);
    backupGuard.retryAt = 0;
    await checkAutoBackup();
    assert.equal(readdirSync(backups).length, 1, 'once the cause is gone one snapshot is written');
    assert.equal(backupGuard.busy, false);
    await save({ backupAutoEnabled: false });

    const mail = globalState('newsletter', () => ({ busy: false }));
    const clock = new Date();
    await save({ newsletterEnabled: true, newsletterDayOfWeek: clock.getDay(), newsletterHour: clock.getHours() });
    mail.busy = true;
    await checkNewsletter();
    assert.equal((await getSettings()).newsletterLastSentAt, null, 'a pass that finds a send running does not start another');
    mail.busy = false;
    await checkNewsletter();
    assert.ok((await getSettings()).newsletterLastSentAt, 'the free pass sends and stamps the lock');
    assert.equal(mail.busy, false, 'the flag is released afterwards');
    await save({ newsletterEnabled: false });
    console.log('ok - overlapping passes cannot start a second backup or newsletter');
  }

  // The streak and the active-day count describe the same days. A play with no duration (an
  // import that never knew it, or an item under a minute) counts for one and used to break the
  // other.
  {
    const { getWrapped } = await import('../server/wrapped');
    const [streaker] = await db
      .insert(users)
      .values({ serverUserId: 'streaker', username: 'streaker' })
      .returning();
    const year = new Date().getFullYear();
    await db.insert(watchHistory).values(
      [10, 11, 12].map((day) => ({
        userId: streaker.id,
        itemId: `streak-${day}`,
        title: `Streak ${day}`,
        mediaType: 'movie',
        genres: [],
        watchedAt: new Date(year, 5, day, 12),
        durationMs: 0,
      })),
    );
    const wrapped = await getWrapped(streaker.id, year);
    assert.equal(wrapped.activeDays, 3);
    assert.equal(wrapped.longestStreak, 3, 'zero-minute plays still make the days consecutive');
    await db.delete(users).where(eq(users.id, streaker.id));
    console.log('ok - wrapped streak agrees with active days');
  }

  // Titles, device names and usernames come from outside and open in a spreadsheet: a leading
  // formula character must not survive, and a real negative number must stay a number.
  {
    const { toCsv } = await import('../server/csv');
    assert.equal(
      toCsv(['t'], [['=1+1'], ['@SUM(A1)'], ['-5'], [-5], ['plain'], ['a\rb']]),
      't\n\'=1+1\n\'@SUM(A1)\n\'-5\n-5\nplain\n"a\rb"',
    );
    console.log('ok - CSV cells cannot start a formula');
  }

  // WAL files stay locked on Windows until the handle is closed.
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

void main();
