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
  // Warned about, not refused: an existing install has its tokens encrypted with this value,
  // so a hard stop would be an outage for something the admin has to fix deliberately.
  if (process.env.NODE_ENV === 'production' && process.env.SESSION_SECRET === 'change-me') {
    console.warn(
      'SESSION_SECRET is still the placeholder from .env.example, so anyone can decrypt the ' +
        'stored tokens from a copy of the database. Generate one with: openssl rand -hex 32. ' +
        'Changing it signs everyone out and the media server tokens have to be entered again.',
    );
  }
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
