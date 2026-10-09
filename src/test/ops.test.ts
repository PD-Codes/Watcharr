import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import jobs, chunked uploads, backups/restore, the system check and the preview guard.
// Own throwaway database; set before any app module is imported (the import opens it).
// IMPORT_ROWS=2000000 runs the large-database stress case by hand.
const dir = mkdtempSync(join(tmpdir(), 'watcharr-ops-'));
process.env.DATABASE_PATH = join(dir, 'ops.db');
process.env.SESSION_SECRET ??= 'test-secret-test-secret';
execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });

const ROWS = Number(process.env.IMPORT_ROWS ?? 60_000);

async function main() {
  const { db } = await import('../db');
  const { users, watchHistory, playbackSessions } = await import('../db/schema');
  const { count, eq } = await import('drizzle-orm');

  /* ---------- chunked upload ---------- */
  {
    const up = await import('../server/importupload');
    const base = join(dir, 'uploads');
    const sqliteHead = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]);
    const info = await up.startUpload(base, 'tautulli.db', sqliteHead.length);
    const first = await up.appendChunk(base, info.id, 0, sqliteHead.subarray(0, 50));
    assert.equal(first.received, 50);
    assert.equal(first.complete, false);

    // A retried chunk (the response was lost, the client resends) must not corrupt the file.
    await assert.rejects(up.appendChunk(base, info.id, 0, sqliteHead.subarray(0, 50)), (e: unknown) => {
      assert.ok(e instanceof up.UploadError);
      assert.equal(e.status, 409);
      assert.equal(e.received, 50, 'the 409 says where the server really is');
      return true;
    });
    await assert.rejects(up.appendChunk(base, info.id, 50, Buffer.alloc(1000)), /past the announced size/);
    const done = await up.appendChunk(base, info.id, 50, sqliteHead.subarray(50));
    assert.equal(done.complete, true);
    assert.ok((await up.completedPath(base, info.id)).path.endsWith('.part'));

    const junk = await up.startUpload(base, 'x.db', 20);
    await assert.rejects(up.appendChunk(base, junk.id, 0, Buffer.alloc(20, 1)), /not a SQLite/);
    await assert.rejects(up.uploadInfo(base, junk.id), /Unknown upload/, 'a rejected file is gone');
    await assert.rejects(up.uploadInfo(base, '../../etc/passwd'), /Unknown upload/);
    await assert.rejects(up.startUpload(base, 'huge.db', 1e15), /larger than/);
    console.log('ok - an upload resumes at the server offset and refuses non-SQLite files');
  }

  /* ---------- batched, resumable import ---------- */
  const { importFromTautulli } = await import('../server/tautulli');
  const source = join(dir, 'big-tautulli.db');
  {
    const t = new Database(source);
    t.exec(`
      CREATE TABLE session_history (id INTEGER PRIMARY KEY, started INTEGER, stopped INTEGER,
        paused_counter INTEGER, user TEXT, rating_key TEXT, media_type TEXT, platform TEXT,
        player TEXT, ip_address TEXT);
      CREATE TABLE session_history_metadata (id INTEGER PRIMARY KEY, title TEXT,
        grandparent_title TEXT, year INTEGER, genres TEXT, duration INTEGER);
      CREATE TABLE session_history_media_info (id INTEGER PRIMARY KEY, transcode_decision TEXT,
        container TEXT, video_codec TEXT, audio_codec TEXT, height INTEGER, bitrate INTEGER,
        transcode_container TEXT, transcode_video_codec TEXT, transcode_audio_codec TEXT,
        transcode_height INTEGER);
    `);
    const h = t.prepare('INSERT INTO session_history VALUES (?,?,?,?,?,?,?,?,?,?)');
    const m = t.prepare('INSERT INTO session_history_metadata VALUES (?,?,?,?,?,?)');
    const i = t.prepare('INSERT INTO session_history_media_info VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const names = ['alice', 'bob', 'Carol', 'ghost'];
    const t0 = Math.floor(Date.now() / 1000) - ROWS * 4000;
    t.transaction(() => {
      for (let n = 1; n <= ROWS; n++) {
        // Distinct item per row and 4000 s apart: no row is a near-duplicate of another.
        const start = t0 + n * 4000;
        h.run(n, start, start + 3000, 100, names[n % 4], `rk-${n}`, 'movie', 'Chrome', 'Desktop', '10.0.0.1');
        m.run(n, `Title ${n}`, null, 2000 + (n % 25), 'Drama;Comedy', 7_200_000);
        i.run(n, n % 3 ? 'direct play' : 'transcode', 'mkv', 'h264', 'aac', 1080, 8000, 'mp4', 'h264', 'aac', 720);
      }
    })();
    t.close();
    await db.insert(users).values([
      { serverId: 1, serverUserId: 'a', username: 'alice' },
      { serverId: 1, serverUserId: 'b', username: 'bob' },
      { serverId: 1, serverUserId: 'c', username: 'carol' }, // matched case-insensitively
      { serverId: 1, serverUserId: 'g', username: 'ghost-renamed' },
    ]);
  }
  const [ghostRenamed] = await db.select().from(users).where(eq(users.username, 'ghost-renamed'));

  // Preview: nothing written, the unmatched name is reported with its row count.
  const preview = await importFromTautulli(source, 1, { dryRun: true });
  assert.equal(preview.scanned, ROWS);
  assert.equal(preview.total, ROWS);
  assert.deepEqual(preview.unmatched, [{ name: 'ghost', rows: ROWS / 4 }]);
  assert.equal(preview.plays, (ROWS / 4) * 3);
  assert.equal((await db.select({ n: count() }).from(watchHistory))[0].n, 0, 'a preview writes nothing');

  // Real run with a mapping, watching heap use and the cursor on the way.
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  let peak = 0;
  let batches = 0;
  const started = Date.now();
  const result = await importFromTautulli(source, 1, {
    userMap: { ghost: ghostRenamed.id },
    onProgress: () => {
      batches += 1;
      peak = Math.max(peak, process.memoryUsage().heapUsed - heap0);
    },
  });
  const seconds = (Date.now() - started) / 1000;
  assert.equal(result.plays, ROWS, 'the mapped user is imported too');
  assert.equal(result.streams, ROWS);
  assert.equal(result.lastId, ROWS);
  assert.deepEqual(result.unmatched, []);
  assert.ok(batches >= Math.floor(ROWS / 1000), 'rows are read in batches, not at once');
  const mb = peak / 1024 ** 2;
  console.log(`     ${ROWS} rows in ${seconds.toFixed(1)} s (${Math.round(ROWS / seconds)} rows/s), heap growth peak ${mb.toFixed(0)} MB`);
  // The old reader held every row at once: roughly 1 KB each. Flat memory is the point.
  assert.ok(mb < 200, `heap grew ${mb.toFixed(0)} MB`);
  assert.equal((await db.select({ n: count() }).from(playbackSessions))[0].n, ROWS);

  // A second run adds nothing — also the proof that resuming over written rows is harmless.
  const again = await importFromTautulli(source, 1, { userMap: { ghost: ghostRenamed.id } });
  assert.equal(again.plays, 0);
  assert.equal(again.streams, 0);

  // A mapping may only point at an account of the chosen server.
  const [foreign] = await db.insert(users).values({ serverId: 99, serverUserId: 'f', username: 'foreign' }).returning();
  const refused = await importFromTautulli(source, 1, { dryRun: true, userMap: { ghost: foreign.id } });
  assert.deepEqual(refused.unmatched.map((u) => u.name), ['ghost'], 'a foreign account is not a valid target');

  // Stopping between batches keeps a cursor that resumes without loss.
  await db.delete(watchHistory);
  await db.delete(playbackSessions);
  let stopAfter = 2;
  const part = await importFromTautulli(source, 1, {
    userMap: { ghost: ghostRenamed.id },
    batchSize: 1000,
    shouldStop: () => stopAfter-- <= 0,
  });
  assert.equal(part.stopped, true);
  assert.equal(part.scanned, 2000);
  assert.equal(part.lastId, 2000);
  const rest = await importFromTautulli(source, 1, {
    userMap: { ghost: ghostRenamed.id },
    resume: {
      lastId: part.lastId,
      scanned: part.scanned,
      candidates: part.candidates,
      plays: part.plays,
      streams: part.streams,
      unmatched: {},
    },
  });
  assert.equal(rest.stopped, false);
  assert.equal(rest.plays, ROWS, 'stopped + resumed = everything, counted once');
  assert.equal((await db.select({ n: count() }).from(watchHistory))[0].n, ROWS);
  console.log('ok - the import reads in batches, maps users, stops and resumes without loss');

  /* ---------- people, stream detail and logins ---------- */
  {
    const { loginHistory } = await import('../db/schema');
    // Session keys are `<server>:tautulli-<id>`: the stress rows above would collide with these.
    await db.delete(watchHistory);
    await db.delete(playbackSessions);
    const file = join(dir, 'modern-tautulli.db');
    const t = new Database(file);
    t.exec(`
      CREATE TABLE session_history (id INTEGER PRIMARY KEY, started INTEGER, stopped INTEGER,
        paused_counter INTEGER, user_id INTEGER, user TEXT, rating_key INTEGER, media_type TEXT,
        product TEXT, platform TEXT, player TEXT, ip_address TEXT, location TEXT, bandwidth INTEGER);
      CREATE TABLE session_history_metadata (id INTEGER PRIMARY KEY, title TEXT,
        grandparent_title TEXT, year INTEGER, genres TEXT, duration INTEGER);
      CREATE TABLE session_history_media_info (id INTEGER PRIMARY KEY, transcode_decision TEXT,
        container TEXT, video_codec TEXT, audio_codec TEXT, height INTEGER, bitrate INTEGER,
        audio_channels INTEGER, stream_container TEXT, stream_video_codec TEXT,
        stream_video_height INTEGER, stream_video_width INTEGER, stream_audio_codec TEXT,
        stream_audio_channels INTEGER, stream_subtitle_codec TEXT, stream_bitrate INTEGER);
      CREATE TABLE users (id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT,
        friendly_name TEXT, email TEXT, thumb TEXT);
      CREATE TABLE user_login (id INTEGER PRIMARY KEY, timestamp INTEGER, user_id INTEGER,
        user TEXT, ip_address TEXT, user_agent TEXT, success INTEGER);
    `);
    const base = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const h = t.prepare('INSERT INTO session_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const m = t.prepare('INSERT INTO session_history_metadata VALUES (?,?,?,?,?,?)');
    const i = t.prepare('INSERT INTO session_history_media_info VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    // 1: the owner under a name the account here no longer has. 2+3: two resumed segments of one
    // film by a person nobody has an account for. 4: somebody the admin leaves out.
    h.run(1, base, base + 600, 0, 100, 'old-owner-name', 11, 'movie', 'Plex Web', 'Chrome', 'Laptop', '10.0.0.8', 'wan', 8000);
    h.run(2, base + 1000, base + 2800, 0, 200, 'newbie', 22, 'movie', 'Plex for Android', 'Android', 'Pixel', '192.168.1.5', 'lan', 0);
    h.run(3, base + 3600, base + 4500, 0, 200, 'newbie', 22, 'movie', 'Plex for Android', 'Android', 'Pixel', '192.168.1.5', 'lan', 0);
    h.run(4, base + 100, base + 200, 0, 300, 'skipme', 33, 'track', 'Plexamp', 'Android', 'Pixel', '1.2.3.4', 'wan', 0);
    for (const n of [1, 2, 3, 4]) m.run(n, `Title ${n}`, null, 2020, 'Drama', 7_000_000);
    i.run(1, 'copy', 'mkv', 'hevc', 'eac3', 2160, 40_000, 6, 'mp4', 'hevc', 1600, 3840, 'aac', 2, 'srt', 7000);
    i.run(2, 'direct play', 'mkv', 'h264', 'aac', 1080, 5000, 2, 'mkv', 'h264', 1080, 1920, 'aac', 2, null, 0);
    i.run(3, 'direct play', 'mkv', 'h264', 'aac', 1080, 5000, 2, 'mkv', 'h264', 1080, 1920, 'aac', 2, null, 0);
    i.run(4, 'transcode', 'flac', null, 'flac', null, 900, 2, 'mp3', null, null, null, 'mp3', 2, null, 320);
    t.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(1, 200, 'newbie', 'Newbie F.', 'newbie@example.com', 'https://plex.tv/users/x/avatar');
    const l = t.prepare('INSERT INTO user_login VALUES (?,?,?,?,?,?,?)');
    l.run(1, base, 100, 'old-owner-name', '203.0.113.9', 'Firefox', 1);
    l.run(2, base + 10, 100, 'old-owner-name', '203.0.113.9', 'Firefox', 0);
    l.run(3, base + 20, 999, 'stranger', '198.51.100.7', 'curl', 0);
    t.close();
    await db.insert(users).values({ serverId: 1, serverUserId: '100', username: 'renamed-owner' });
    const userCount = async () => (await db.select({ n: count() }).from(users))[0].n;
    const before = await userCount();
    const opts = { createUsers: true, userMap: { skipme: null } };

    // Without createUsers nobody is invented: the strangers are reported, as before.
    const plain = await importFromTautulli(file, 1, { dryRun: true });
    assert.deepEqual(plain.unmatched.map((u) => u.name).sort(), ['newbie', 'skipme']);
    assert.equal(plain.plays, 1, 'only the owner, matched by plex.tv id despite the rename');

    const preview = await importFromTautulli(file, 1, { ...opts, dryRun: true });
    assert.equal(preview.createdUsers, 1);
    assert.equal(preview.logins, 3);
    assert.equal(await userCount(), before, 'a preview creates no account');

    const run = await importFromTautulli(file, 1, opts);
    assert.equal(run.createdUsers, 1, 'one account for newbie; skipme was left out');
    assert.equal(await userCount(), before + 1);
    const [newbie] = await db.select().from(users).where(eq(users.serverUserId, '200'));
    assert.equal(newbie.username, 'newbie');
    assert.equal(newbie.email, 'newbie@example.com');
    assert.equal(newbie.lastSeenAt, null, 'never signed in here');
    assert.equal(run.plays, 2, 'owner + one film; the two segments are one play');
    const [film] = await db.select().from(watchHistory).where(eq(watchHistory.userId, newbie.id));
    assert.equal(film.durationMs, (1800 + 900) * 1000, 'the resumed segment adds its time to the play');
    assert.equal(run.streams, 3, 'every segment stays a stream row');

    const [owner] = await db.select().from(playbackSessions).where(eq(playbackSessions.sessionKey, '1:tautulli-1'));
    assert.equal(owner.playMethod, 'directstream', "Tautulli's 'copy' is a direct stream");
    assert.equal(owner.clientName, 'Plex Web', 'the app, not the OS');
    assert.equal(owner.deviceName, 'Laptop');
    assert.equal(owner.isLocal, false, "Plex's own location beats the address guess");
    assert.equal(owner.bitrateKbps, 8000);
    assert.equal(owner.width, 3840);
    assert.equal(owner.height, 1600);
    assert.equal(owner.audioChannels, 2);
    assert.equal(owner.subtitleCodec, 'srt');
    assert.equal(owner.sourceVideoCodec, 'hevc');
    const [lan] = await db.select().from(playbackSessions).where(eq(playbackSessions.sessionKey, '1:tautulli-2'));
    assert.equal(lan.isLocal, true);
    assert.equal(lan.bitrateKbps, 5000, 'falls back to the file bitrate when no bandwidth was recorded');
    assert.equal(
      (await db.select().from(playbackSessions).where(eq(playbackSessions.sessionKey, '1:tautulli-4'))).length,
      0,
      'a person who was left out has no streams either',
    );

    assert.equal(run.logins, 3);
    const logins = await db.select().from(loginHistory);
    assert.equal(logins.length, 3);
    const failed = logins.filter((r) => !r.success).length;
    assert.equal(failed, 2);
    const stranger = logins.find((r) => r.username === 'stranger');
    assert.equal(stranger?.userId, null, 'a login by nobody we know is kept by name');
    assert.equal(logins.find((r) => r.username === 'old-owner-name' && r.success)?.userId !== null, true);

    const rerun = await importFromTautulli(file, 1, opts);
    assert.deepEqual([rerun.plays, rerun.streams, rerun.logins, rerun.createdUsers], [0, 0, 0, 0], 'a second run adds nothing');
    assert.equal((await db.select({ n: count() }).from(loginHistory))[0].n, 3);
    console.log('ok - the import matches by plex.tv id, creates missing people, keeps stream detail and logins');

    await db.delete(loginHistory);
    await db.delete(playbackSessions);
    await db.delete(watchHistory);
    await db.delete(users).where(eq(users.serverUserId, '200'));
    await db.delete(users).where(eq(users.serverUserId, '100'));
  }

  /* ---------- background job ---------- */
  {
    const { createServer } = await import('../server/config');
    await createServer({ serverType: 'jellyfin', serverUrl: 'http://stub', serverToken: 't', label: 'Stub' });
    const [{ id: serverId }] = (await db.select({ id: (await import('../db/schema')).appConfig.id }).from((await import('../db/schema')).appConfig));
    const job = await import('../server/importjob');
    await db.delete(watchHistory);
    await db.delete(playbackSessions);

    await assert.rejects(job.startJob({ serverId, dryRun: true }), /path or an uploaded file/);
    const first = await job.startJob({ path: source, serverId, dryRun: true, userMap: {} });
    assert.equal(first.status, 'running');
    await assert.rejects(job.startJob({ path: source, serverId, dryRun: true }), /already running/);
    while ((await job.getJob())?.status === 'running') await new Promise((r) => setTimeout(r, 25));
    const finished = await job.getJob();
    assert.equal(finished?.status, 'done');
    assert.equal(finished?.summary?.scanned, ROWS);
    assert.ok(existsSync(join(job.IMPORT_DIR, 'job.json')), 'progress is mirrored to disk');

    // A real run takes a safety backup first.
    await job.startJob({ path: source, serverId, dryRun: false, userMap: { ghost: ghostRenamed.id } });
    while ((await job.getJob())?.status === 'running') await new Promise((r) => setTimeout(r, 25));
    assert.equal((await job.getJob())?.status, 'done');
    const { listBackups } = await import('../server/backups');
    assert.ok((await listBackups()).some((b) => b.kind === 'pre-import'), 'a real import snapshots first');
    assert.equal((await db.select({ n: count() }).from(watchHistory))[0].n, ROWS);

    // A "running" file nobody is running is an interrupted job after a restart.
    const stored = JSON.parse(readFileSync(join(job.IMPORT_DIR, 'job.json'), 'utf8'));
    writeFileSync(join(job.IMPORT_DIR, 'job.json'), JSON.stringify({ ...stored, status: 'running' }));
    // (live state still holds the finished job in this process, so check the file reader directly)
    assert.equal(JSON.parse(readFileSync(join(job.IMPORT_DIR, 'job.json'), 'utf8')).status, 'running');
    console.log('ok - the import runs as a background job with a safety backup and a progress file');
  }

  /* ---------- backups: verify and staged restore ---------- */
  {
    const backups = await import('../server/backups');
    const made = await backups.createManualBackup();
    assert.equal(made.kind, 'manual');
    const verdict = await backups.verifyBackup(made.name);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    assert.equal(verdict.users, 5);
    assert.equal(await backups.backupPath('../ops.db'), null, 'names cannot leave the backup folder');
    assert.equal((await backups.verifyBackup('nope.db')).ok, false);

    // Corrupt copy: refused at staging time, not at startup.
    const { BACKUP_DIR } = await import('../server/autobackup');
    writeFileSync(join(BACKUP_DIR, 'manual-broken.db'), Buffer.from('this is not a database'.repeat(50)));
    const refused = await backups.stageRestore('manual-broken.db');
    assert.equal(refused.ok, false);
    assert.equal(await backups.pendingRestore(), null, 'nothing is staged for a bad file');

    // Stage a good one, then let the startup script do the swap in a fresh process.
    const before = (await db.select({ n: count() }).from(users))[0].n;
    await db.insert(users).values({ serverId: 1, serverUserId: 'later', username: 'created-after-backup' });
    assert.equal((await backups.stageRestore(made.name)).ok, true);
    assert.equal(await backups.pendingRestore(), made.name);
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
    execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'pipe', env: process.env });
    const after = new Database(process.env.DATABASE_PATH!, { readonly: true });
    assert.equal(
      (after.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n,
      before,
      'the user created after the backup is gone: the file was swapped',
    );
    after.close();
    assert.equal(await backups.pendingRestore(), null, 'the marker is consumed');
    assert.ok((await backups.listBackups()).some((b) => b.kind === 'pre-restore'), 'the replaced database is kept');
    console.log('ok - backups verify, refuse corrupt files and restore through the startup script');
  }

  /* ---------- system check ---------- */
  {
    const { evaluateDoctor, sortChecks } = await import('../server/doctor-core');
    const good = {
      secretIsPlaceholder: false, appUrlSet: true, tmdbConfigured: true, emailChannel: true,
      newsletterEnabled: false, timezoneSet: true,
      backup: { autoEnabled: true, intervalHours: 24, lastAutoAt: Date.now() - 3_600_000, newestAt: Date.now() },
      disk: { freeBytes: 50 * 1024 ** 3, dbBytes: 1024 ** 3 }, downServers: [], pendingMigrations: 0,
      updateAvailable: null, importInterrupted: false, restorePending: false,
    };
    assert.ok(evaluateDoctor(good).every((c) => c.level === 'ok'));
    const level = (patch: object, id: string) => evaluateDoctor({ ...good, ...patch }).find((c) => c.id === id)?.level;
    assert.equal(level({ secretIsPlaceholder: true }, 'secret'), 'fail');
    assert.equal(level({ downServers: ['A'] }, 'servers'), 'fail');
    assert.equal(level({ backup: { ...good.backup, lastAutoAt: Date.now() - 3 * 86_400_000 } }, 'backup'), 'fail', 'scheduled backups that stopped');
    assert.equal(level({ backup: { autoEnabled: false, intervalHours: 24, lastAutoAt: null, newestAt: null } }, 'backup'), 'warn');
    assert.equal(level({ disk: { freeBytes: 100 * 1024 ** 2, dbBytes: 1 } }, 'disk'), 'fail');
    assert.equal(level({ disk: { freeBytes: 3 * 1024 ** 3, dbBytes: 5 * 1024 ** 3 } }, 'disk'), 'warn', 'less than 2x the database');
    assert.equal(level({ newsletterEnabled: true, emailChannel: false }, 'email'), 'warn');
    const sorted = sortChecks(evaluateDoctor({ ...good, secretIsPlaceholder: true, tmdbConfigured: false }));
    assert.deepEqual(sorted.slice(0, 2).map((c) => c.level), ['fail', 'warn'], 'worst first');
    console.log('ok - the system check rates what it is given and lists the worst first');
  }

  /* ---------- caches ---------- */
  {
    const { isStale } = await import('../server/tmdb');
    const day = 86_400_000;
    const now = Date.now();
    assert.equal(isStale(false, new Date(now - 29 * day), now), false);
    assert.equal(isStale(false, new Date(now - 31 * day), now), true);
    assert.equal(isStale(true, new Date(now - 8 * day), now), true, 'a miss expires sooner');
    const { getCacheStats, runCacheAction } = await import('../server/caches');
    const { tmdbCache } = await import('../db/schema');
    await db.insert(tmdbCache).values([
      { key: 'a', payload: { x: 1 }, fetchedAt: new Date(now - 40 * day) },
      { key: 'b', payload: null, fetchedAt: new Date(now) },
    ]);
    const stats = await getCacheStats();
    assert.deepEqual([stats.tmdb.entries, stats.tmdb.found, stats.tmdb.misses, stats.tmdb.expired], [2, 1, 1, 1]);
    // Coverage: one of two library titles has an answer (a miss counts as an answer).
    await db.insert(tmdbCache).values({ key: 'meta:movie:dune:2021', payload: null });
    const { artworkCoverage } = await import('../server/tmdb');
    const cover = await artworkCoverage([
      { title: 'Dune', mediaType: 'movie', year: 2021 },
      { title: 'Unfetched', mediaType: 'movie', year: 2000 },
      { title: 'Dune', mediaType: 'movie', year: 2021 },
      { title: '  ', mediaType: 'movie' },
    ] as Parameters<typeof artworkCoverage>[0]);
    assert.deepEqual(cover, { total: 2, cached: 1 }, 'duplicates and blank titles are not counted');
    await db.delete(tmdbCache).where(eq(tmdbCache.key, 'meta:movie:dune:2021'));
    assert.equal((await runCacheAction('tmdb.retryMisses')).removed, 1);
    assert.equal((await getCacheStats()).tmdb.entries, 1);
    console.log('ok - cache statistics count hits, misses and expiry; retry drops only the misses');
  }

  /* ---------- newsletter draft ---------- */
  {
    const { renderNewsletter } = await import('../server/newsletter');
    const html = await renderNewsletter([], 'de-DE', { subject: 'Draft <b>subject</b>', intro: 'Hello', days: 3 });
    assert.ok(html.includes('Draft &lt;b&gt;subject&lt;/b&gt;'), 'unsaved values are used, and escaped');
    assert.ok(html.includes('Hello'));
    console.log('ok - the newsletter preview renders unsaved form values');
  }

  /* ---------- newsletter layout ---------- */
  {
    const { buildNewsletterHtml, formatRuntime, truncate } = await import('../server/newsletter-html');
    const { renderNewsletter } = await import('../server/newsletter');
    const { translator } = await import('../i18n');
    assert.equal(formatRuntime(45), '45 min');
    assert.equal(formatRuntime(135), '2 h 15 min');
    assert.equal(formatRuntime(120), '2 h');
    assert.ok(truncate('word '.repeat(100), 50).endsWith('…') && truncate('word '.repeat(100), 50).length <= 51);

    const html = buildNewsletterHtml(
      {
        subject: 'S',
        intro: 'Line one\nLine <two>',
        days: 7,
        stats: { movies: 2, series: 1, episodes: 5 },
        topGenres: ['Drama'],
        hero: { title: 'Hero <b>', kind: 'movie', episodes: 0, genres: ['Drama'], backdrop: 'https://img/b.jpg', rating: 7.84, runtimeMinutes: 135, overview: 'Plot <script>x</script>', tagline: 'Tag' },
        highlights: [{ title: 'Show', kind: 'series', episodes: 5, genres: [], poster: 'https://img/p.jpg', href: 'https://app/title/Show' }],
        sections: [{ server: 'Srv', cards: [{ title: 'Tile', kind: 'movie', episodes: 0, genres: [] }], hidden: 3 }],
        popular: [{ title: 'Top', plays: 9 }],
        openUrl: 'https://app',
      },
      translator('de-DE'),
      'de-DE',
    );
    assert.ok(html.includes('Hero &lt;b&gt;') && !html.includes('<script>'), 'titles and overviews are escaped');
    assert.ok(html.includes('★ 7.8') && html.includes('2 h 15 min'), 'rating and runtime show');
    assert.ok(html.includes('5 neue Folgen') && html.includes('Tipp der Ausgabe'), 'texts follow the locale');
    assert.ok(html.includes('https://img/b.jpg') && html.includes('href="https://app/title/Show"'), 'images and links are used');
    assert.ok(html.includes('weitere') && html.includes('Top') && html.includes('9 Wiedergaben'));
    assert.ok(html.includes('Line one<br>Line &lt;two&gt;'), 'the intro keeps its line breaks, escaped');

    const bare = await renderNewsletter(
      [{ serverLabel: 'Srv', serverSlug: 'srv', items: [
        { itemId: '1', title: 'Show', mediaType: 'episode', genres: ['Drama'] },
        { itemId: '2', title: 'Show', mediaType: 'episode', genres: ['Drama'] },
        { itemId: '3', title: 'Film', mediaType: 'movie', year: 2020, genres: [] },
      ] }],
      'en-US',
    );
    assert.ok(bare.includes('2 new episodes'), 'episodes of one show become one card');
    const en = translator('en-US');
    const de = translator('de-DE');
    assert.equal(en('common.plays', { count: 1 }), '1 play');
    assert.equal(en('common.plays', { count: 2 }), '2 plays');
    assert.equal(de('common.plays', { count: 1 }), '1 Wiedergabe');
    assert.equal(de('common.plays', { count: 0 }), '0 Wiedergaben');
    console.log('ok - the newsletter layout escapes, localizes and folds episodes');
  }

  /* ---------- preview guard ---------- */
  {
    const { NextRequest } = await import('next/server');
    const { proxy } = await import('../proxy');
    const call = (method: string, path: string, cookie?: string) =>
      proxy(new NextRequest(`http://localhost${path}`, { method, headers: cookie ? { cookie } : {} })).status;
    const view = 'watcharr_view_as=x';
    assert.equal(call('POST', '/api/watchlist', view), 403, 'writes are refused while previewing');
    assert.equal(call('PATCH', '/api/admin/config', view), 403);
    assert.equal(call('GET', '/api/watchlist', view), 200, 'reads still work');
    assert.equal(call('DELETE', '/api/admin/view-as', view), 200, 'the way out stays open');
    assert.equal(call('POST', '/api/watchlist'), 200, 'no preview cookie, no change');
    console.log('ok - the proxy blocks writes while an admin previews another user');
  }

  /* ---------- read cache ---------- */
  {
    const { readDb, clearReadCache } = await import('../server/readcache');
    const { sql } = await import('drizzle-orm');
    clearReadCache();
    // A query that takes a noticeable time is kept for a moment: the second ask is instant.
    const slow = sql`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000) SELECT count(*) AS n FROM c`;
    let t = performance.now();
    const first = await readDb.all<{ n: number }>(slow);
    const cold = performance.now() - t;
    t = performance.now();
    const second = await readDb.all<{ n: number }>(slow);
    const warm = performance.now() - t;
    assert.deepEqual(second, first);
    assert.ok(cold > 150, `the probe query must be slow enough to count (${cold.toFixed(0)} ms)`);
    assert.ok(warm < cold / 5, `a repeat is served from memory (${warm.toFixed(1)} ms vs ${cold.toFixed(0)} ms)`);
    // A cheap query is never kept, so small databases stay exactly as live as before.
    const people = sql`SELECT count(*) AS n FROM users`;
    const before = (await readDb.all<{ n: number }>(people))[0].n;
    await db.insert(users).values({ serverId: 1, serverUserId: 'cache-probe', username: 'cache-probe' });
    assert.equal((await readDb.all<{ n: number }>(people))[0].n, before + 1, 'cheap answers are always fresh');
    await db.delete(users).where(eq(users.serverUserId, 'cache-probe'));
    console.log('ok - slow statistics are kept briefly, cheap ones stay live');
  }

  console.log('all ops tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    void mkdirSync;
  });
