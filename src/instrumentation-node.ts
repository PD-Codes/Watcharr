import { secretProblem, secretWarning } from './server/secret';

/**
 * The Node.js half of instrumentation.ts, loaded only in the nodejs runtime. See there for why
 * it is a separate module.
 */
export async function registerNode() {
  // The build's page collection loads this too; there is no database to open then.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  // Next exits with 143 on SIGTERM, which Docker records as a crash and Portainer flags after
  // every restart, although a stop is exactly what was asked for. The Dockerfile sets
  // NEXT_MANUAL_SIG_HANDLE so Next leaves the signals alone; exiting 0 still runs the
  // database's exit hook (WAL checkpoint).
  if (process.env.NEXT_MANUAL_SIG_HANDLE) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void shutdown());
  }
  // Warned about, not refused: an existing install has its tokens encrypted with this value,
  // so a hard stop would be an outage for something the admin has to fix deliberately. A new
  // install is refused by scripts/migrate.mjs before it gets here.
  const problem = process.env.NODE_ENV === 'production' ? secretProblem() : null;
  if (problem) console.warn(secretWarning(problem));
  // While nobody is admin yet, the console shows the one-time setup token. Best effort: on a
  // brand-new database the table may not exist for another moment, and the login page asks again.
  await import('./server/setuptoken').then((m) => m.announceSetupToken()).catch(() => {});
  await import('./server/startup').then((m) => m.logStartup()).catch(() => {});
  // Escape hatch for anyone running the container purely as a web front end, and for the
  // route test suite, which boots the app against a stub that speaks no websockets.
  if (process.env.WATCHARR_NO_BACKGROUND === '1') return;

  const { startLive } = await import('./server/live');
  startLive();
}

/**
 * Stops the reader threads before exiting, so the exit hook in db/index.ts finds the main
 * connection as the last one on the file and its checkpoint can truncate the WAL. Bounded:
 * Docker sends SIGKILL ten seconds after SIGTERM, and a clean exit with a WAL left behind is
 * still better than that.
 */
async function shutdown() {
  const stop = import('./db/readers').then((m) => m.stopReaders()).catch(() => {});
  await Promise.race([stop, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
  process.exit(0);
}
