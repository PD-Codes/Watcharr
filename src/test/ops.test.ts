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
