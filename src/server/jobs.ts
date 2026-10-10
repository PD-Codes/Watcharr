// One run per job at a time. No 'server-only': pure, and the test script imports it.
//
// Several triggers start the same work: the 30-second tick, the 5-second tick while something
// plays, every websocket frame, every page render. A job that takes longer than its trigger
// interval (a slow media server) used to be started again on top of itself, and each copy
// asked the server the same questions. Now a second caller joins the run in flight instead.

const root = globalThis as unknown as { __watcharrJobs?: Map<string, Promise<unknown>> };
const running = () => (root.__watcharrJobs ??= new Map());

/** Runs `fn` under `key`, or hands back the run already in flight for that key. */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const current = running().get(key);
  if (current) return current as Promise<T>;
  const run = Promise.resolve()
    .then(fn)
    .finally(() => running().delete(key));
  running().set(key, run);
  return run;
}

/** A run this long is worth a line in the log even without debug logging. */
export const SLOW_JOB_MS = 10_000;

const debug = () => process.env.WATCHARR_LOG === 'debug';

/**
 * Runs a job and says how long it took: always when it was slow, every time with
 * WATCHARR_LOG=debug. Without this the container log stayed silent after "Ready", and a sync
 * that took half a minute left no trace anywhere.
 */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - started;
    if (ms >= SLOW_JOB_MS) console.warn(`[watcharr] ${name} took ${(ms / 1000).toFixed(1)} s`);
    else if (debug()) console.log(`[watcharr] ${name}: ${ms} ms`);
  }
}

/** Whether a job is running right now. */
export function isRunning(key: string): boolean {
  return running().has(key);
}
