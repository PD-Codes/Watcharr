// Next.js bundles instrumentation.ts (the background tick) and the request handlers as separate
// module graphs inside one process, so a module-level Map or flag exists once per graph: the
// tick and the page renders each throttled, cached and alerted on their own copy. State that
// has to be process-wide lives here, on globalThis, which is the one thing both graphs share.
// Not for state that is meant to stay per module. No 'server-only' import: pure, and testable.

const root = globalThis as unknown as { __watcharrState?: Map<string, unknown> };

/** The process-wide value for `key`, created by `init` on first use. Keys are plain literals. */
export function globalState<T>(key: string, init: () => T): T {
  const store = (root.__watcharrState ??= new Map());
  if (!store.has(key)) store.set(key, init());
  return store.get(key) as T;
}
