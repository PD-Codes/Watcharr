/**
 * Next.js runs register() once when the server process starts. That is the one hook this
 * app needs a background worker in — everything else has always run inside a page render,
 * which is why a deployment with no browser open synced nothing at all.
 *
 * Kept to a single call on purpose: the work itself lives in server/live.ts, and this file
 * only decides that it is allowed to happen here.
 */
export async function register() {
  // The hook also runs for the edge runtime and during the build's page collection, where
  // there is neither a database file nor any reason to open a socket.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  // Escape hatch for anyone running the container purely as a web front end, and for the
  // route test suite, which boots the app against a stub that speaks no websockets.
  if (process.env.WATCHARR_NO_BACKGROUND === '1') return;

  const { startLive } = await import('./server/live');
  startLive();
}
