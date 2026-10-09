import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Not part of `npm test`: builds a database the size of a hundred-person deployment after
// several years and times the aggregates behind the pages. By hand:
//   SCALE_PLAYS=1000000 npx tsx --expose-gc --require ./src/test/server-only-shim.cjs src/test/scale.bench.ts
const PLAYS = Number(process.env.SCALE_PLAYS ?? 1_000_000);
const USERS = Number(process.env.SCALE_USERS ?? 100);
// SCALE_DB=/path/to/scale.db reuses a database a previous run built (and skips the build).
const reuse = process.env.SCALE_DB && existsSync(process.env.SCALE_DB);
process.env.DATABASE_PATH = process.env.SCALE_DB ?? join(mkdtempSync(join(tmpdir(), 'watcharr-scale-')), 'scale.db');
process.env.SESSION_SECRET ??= 'test-secret-test-secret';
if (!reuse) execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'ignore', env: process.env });

async function main() {
  const { db } = await import('../db');
  const raw = db.$client;
  const now = Date.now();
  const FIVE_YEARS = 5 * 365 * 86_400_000;
  const shows = Array.from({ length: 1500 }, (_, i) => `Show ${i}`);
  const genres = ['Drama', 'Comedy', 'Action', 'Sci-Fi', 'Anime', 'Documentary', 'Horror', 'Music'];
  const devices = ['XBOX', 'Pixel', 'Chrome', 'Living Room TV', 'iPad', 'Samsung TV'];

  const t0 = Date.now();
  if (!reuse) raw.transaction(() => {
    const u = raw.prepare("INSERT INTO users (server_id, server_user_id, username) VALUES (1, ?, ?)");
    for (let i = 0; i < USERS; i++) u.run(String(1000 + i), `user${i}`);
    const h = raw.prepare(
      `INSERT INTO watch_history (user_id, item_id, title, grandparent_title, media_type, year, genres, watched_at, duration_ms, device_name, source)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'tautulli')`,
    );
    const p = raw.prepare(
      `INSERT INTO playback_sessions (session_key, user_id, item_id, title, grandparent_title, media_type, state, progress_ms, duration_ms,
         client_name, device_name, play_method, video_codec, audio_codec, container, height, bitrate_kbps, remote_address, is_local,
         started_at, last_seen_at, progress_at) VALUES (?,?,?,?,?,?,'ended',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let n = 0; n < PLAYS; n++) {
      // Skewed: a few heavy users, a long tail. Distinct (user,item,time) so the unique index holds.
      const user = 1 + Math.floor(USERS * Math.random() ** 2);
      const at = now - Math.floor(Math.random() * FIVE_YEARS);
      const show = Math.random() < 0.8 ? shows[Math.floor(Math.random() * shows.length)] : null;
      const item = String(Math.floor(Math.random() * 40_000));
      const type = show ? 'episode' : Math.random() < 0.8 ? 'movie' : 'track';
      const g = JSON.stringify([genres[n % 8], genres[(n * 7) % 8]]);
      const dur = 600_000 + Math.floor(Math.random() * 6_000_000);
      h.run(user, item, `Title ${item}`, show, type, 1990 + (n % 35), g, at + n % 1000, dur, devices[n % 6], );
      p.run(`1:s-${n}`, user, item, `Title ${item}`, show, type, dur, dur + 1000, 'Plex for X', devices[n % 6],
        n % 7 === 0 ? 'transcode' : 'directplay', 'h264', 'aac', 'mkv', 1080, 5000, `10.0.${n % 250}.${n % 200}`, n % 3 === 0 ? 1 : 0,
        at, at + dur, at + dur);
    }
    const l = raw.prepare("INSERT INTO login_history (server_id, user_id, username, success, ip, created_at) VALUES (1,?,?,?,?,?)");
    for (let n = 0; n < PLAYS / 10; n++) {
      l.run(1 + (n % USERS), `user${n % USERS}`, n % 9 ? 1 : 0, `10.1.${n % 250}.${n % 100}`, now - Math.floor(Math.random() * FIVE_YEARS));
    }
  })();
  if (!reuse) raw.exec('ANALYZE');
  console.log(reuse ? 'reusing database' : `built ${PLAYS} plays + ${PLAYS} streams + ${PLAYS / 10} logins for ${USERS} users in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  const stats = await import('../server/stats');
  const playback = await import('../server/playback');
  const insights = await import('../server/insights');
  const session = await import('../server/session');
  const titles = await import('../server/titles');
  const wrapped = await import('../server/wrapped');
  const all = { userId: null } as const;
  const one = { userId: 3 } as const;
  const cases: [string, () => Promise<unknown>][] = [];
  for (const [label, scope] of [['all', all], ['user', one]] as const) {
    const s = scope;
    cases.push(
      [`getTotals ${label}`, () => stats.getTotals(s)],
      [`getTotals ${label} 30d`, () => stats.getTotals(s, 30)],
      [`getSystemCounts ${label}`, () => stats.getSystemCounts(s)],
      [`getDailyActivity ${label}`, () => stats.getDailyActivity(s, 30)],
      [`getDailyPlays ${label} 365`, () => stats.getDailyPlays(s, 365)],
      [`getWeekdayPlays ${label}`, () => stats.getWeekdayPlays(s)],
      [`getPlaysByMediaType ${label}`, () => stats.getPlaysByMediaType(s)],
      [`getTopGenres ${label}`, () => stats.getTopGenres(s)],
      [`getTopTitles ${label}`, () => stats.getTopTitles(s)],
      [`getTopTitlesByType ${label}`, () => stats.getTopTitlesByType(s, 'movie')],
      [`getPopularTitlesByType ${label}`, () => stats.getPopularTitlesByType(s, 'episode')],
      [`getRecentPlays ${label}`, () => stats.getRecentPlays(s)],
      [`getTopDevices ${label}`, () => stats.getTopDevices(s)],
      [`getHighlights ${label}`, () => stats.getHighlights(s)],
      [`getLongestStreak ${label}`, () => stats.getLongestStreak(s)],
      [`getPeakHours ${label}`, () => stats.getPeakHours(s)],
      [`getStreak ${label}`, () => stats.getStreak(s)],
      [`getMonthlyActivity ${label}`, () => stats.getMonthlyActivity(s)],
      [`getWeekHourGrid ${label}`, () => stats.getWeekHourGrid(s)],
      [`getRewatchSplit ${label}`, () => stats.getRewatchSplit(s)],
      [`getRecords ${label}`, () => stats.getRecords(s)],
      [`getTrend ${label}`, () => stats.getTrend(s, 30)],
      [`getPeriodComparison ${label}`, () => stats.getPeriodComparison(s, 30)],
      [`getCompletionSplit ${label}`, () => playback.getCompletionSplit(85, undefined, s)],
      [`getPlaybackTotals ${label}`, () => playback.getPlaybackTotals(undefined, s)],
      [`getPlaybackTotals ${label} 30d`, () => playback.getPlaybackTotals(30, s)],
      [`getClientWatchtime ${label}`, () => playback.getClientWatchtime(undefined, s)],
      [`getConcurrencyPeak ${label}`, () => playback.getConcurrencyPeak(30, s)],
      [`getConcurrencyOverTime ${label}`, () => playback.getConcurrencyOverTime(7, s)],
      [`getBandwidthOverTime ${label}`, () => playback.getBandwidthOverTime(7, s)],
      [`getStreamTypesOverTime ${label}`, () => playback.getStreamTypesOverTime(30, s)],
      [`listSessionHistory ${label}`, () => playback.listSessionHistory({ scope: s })],
      [`listSessionHistory transcodes ${label}`, () => playback.listSessionHistory({ scope: s, transcodesOnly: true, days: 30 })],
      [`getInsights ${label}`, () => insights.getInsights(s)],
      [`getAchievements ${label}`, () => insights.getAchievements(s)],
    );
  }
  cases.push(
    [`getPlaysByUser`, () => stats.getPlaysByUser()],
    [`getUserLeaderboard`, () => stats.getUserLeaderboard()],
    [`getUserAddresses`, () => playback.getUserAddresses(3)],
    [`getUserPlayers`, () => playback.getUserPlayers(3)],
    [`listLoginHistory`, () => session.listLoginHistory()],
    [`getTitleDetail all`, () => titles.getTitleDetail('Show 5', all)],
    [`getTitleDetail user`, () => titles.getTitleDetail('Show 5', one)],
    [`getItemDetail all`, () => titles.getItemDetail('123', all)],
    [`getWrapped user`, () => wrapped.getWrapped(3, new Date().getFullYear() - 1)],
  );

  console.log('--- timings ---');
  const rows: [string, number][] = [];
  for (const [name, run] of cases) {
    global.gc?.();
    const t = performance.now();
    try {
      await run();
    } catch (error) {
      console.log(`!! ${name}: ${error instanceof Error ? error.message : error}`);
    }
    rows.push([name, performance.now() - t]);
    console.log(`${(performance.now() - t).toFixed(0).padStart(7)} ms  ${name}`);
  }
  rows.sort((a, b) => b[1] - a[1]);
  for (const [name, ms] of rows.slice(0, 25)) console.log(`${ms.toFixed(0).padStart(7)} ms  ${name}`);
  const total = rows.reduce((a, [, ms]) => a + ms, 0);
  console.log(`sum of ${rows.length} queries: ${(total / 1000).toFixed(1)} s; heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
}
main().catch((e) => { console.error(e); process.exit(1); });
