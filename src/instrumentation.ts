/**
 * Next.js runs register() once when the server process starts. That is the one hook this
 * app needs a background worker in — everything else has always run inside a page render,
 * which is why a deployment with no browser open synced nothing at all.
 *
 * Kept to a single call on purpose: the work itself lives in instrumentation-node.ts and
 * server/live.ts, and this file only decides that it is allowed to happen here.
 */
export async function register() {
  // The hook also runs for the edge runtime, where there is neither a database file nor any
  // reason to open a socket. The Node part sits behind a dynamic import inside this check so
  // the edge bundle never sees process.exit/process.once (Turbopack warns about them otherwise).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node').then((m) => m.registerNode());
  }
}
