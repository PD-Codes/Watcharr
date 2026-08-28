import 'server-only';
import { createAdapter, supportsLiveSocket, type ServerType } from './adapters';
import { getSettings, listServers } from './config';
import { isEnabled } from './features';
import { syncActivity } from './sync';

/**
 * Live event sockets to the configured media servers.
 *
 * Until now every piece of live data was pulled during a page render: no open tab meant no
 * polling, and with one open the freshest possible answer was still up to five seconds
 * old. Both media servers push playback events over a websocket, so the app listens and
 * re-reads the session list when something actually happens.
 *
 * Two deliberate limits:
 *
 *   - The socket is a doorbell, never a data path. Nothing here parses a frame; the
 *     adapters keep their monopoly on what a media server's answers mean, and a protocol
 *     change upstream can at worst cost the latency this buys back, never correctness.
 *   - A slow interval keeps running underneath. A socket that is up but silent — a proxy
 *     holding a dead connection open is the classic case — must not be the only thing
 *     standing between the app and its data.
 *
 * ponytail: in-process, one container, no coordination. Two app instances would each open
 * their own socket and each run the sync; that is the same assumption the throttle in
 * sync.ts already makes.
 */

// Long enough that it is a safety net rather than a poller, short enough that a deployment
// whose servers do not speak websockets still behaves like it did before.
const FALLBACK_MS = 30_000;
const RECONNECT_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;

type Listener = { socket: WebSocket; serverId: number };

const listeners = new Map<number, Listener>();
const backoff = new Map<number, number>();
let timer: NodeJS.Timeout | null = null;
let started = false;

function onEvent(label: string) {
  // Errors are swallowed on purpose: this runs outside any request, so an unhandled
  // rejection here would take the whole process down over a media server hiccup.
  void syncActivity(true).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[watcharr] live sync from ${label} failed: ${message}`);
  });
}

function connect(serverId: number, label: string, url: string, hello?: string) {
  let socket: WebSocket;
  try {
    // Global WebSocket, no dependency: Node has shipped one since 22.
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect(serverId, label, url, hello);
    return;
  }
  listeners.set(serverId, { socket, serverId });

  socket.onopen = () => {
    backoff.delete(serverId);
    if (hello) socket.send(hello);
    console.log(`[watcharr] live events connected: ${label}`);
    onEvent(label);
  };
  // Every frame means the same thing here: something changed, go and look.
  socket.onmessage = () => onEvent(label);
  // Both handlers, because a failed connection fires error and close, and only close is
  // guaranteed. Without onerror the failure would surface as an unhandled event instead.
  socket.onerror = () => {};
  socket.onclose = () => {
    if (listeners.get(serverId)?.socket === socket) listeners.delete(serverId);
    scheduleReconnect(serverId, label, url, hello);
  };
}

function scheduleReconnect(serverId: number, label: string, url: string, hello?: string) {
  const wait = Math.min(MAX_BACKOFF_MS, backoff.get(serverId) ?? RECONNECT_MS);
  // Doubles until the ceiling: a server that is down for the night must not be dialled
  // every fifteen seconds until morning.
  backoff.set(serverId, Math.min(MAX_BACKOFF_MS, wait * 2));
  setTimeout(() => {
    if (!started) return;
    if (listeners.has(serverId)) return;
    connect(serverId, label, url, hello);
  }, wait).unref?.();
}

/** Opens a socket for every configured server that offers one. Safe to call repeatedly. */
export async function refreshListeners(): Promise<void> {
  const settings = await getSettings();
  if (!isEnabled(settings.features, 'liveSocket')) {
    // Only the sockets go. The interval below stays, because it is also what keeps the
    // background work running — turning the socket off must not turn the app back into
    // something that only syncs while somebody has a tab open.
    closeSockets();
    return;
  }

  const servers = await listServers();
  const wanted = new Set(servers.map((server) => server.id));
  // A server that was removed or renamed keeps a socket open to an address that no longer
  // belongs to this deployment, so its listener goes first.
  for (const [serverId, listener] of listeners) {
    if (!wanted.has(serverId)) {
      listener.socket.close();
      listeners.delete(serverId);
    }
  }

  for (const server of servers) {
    if (listeners.has(server.id)) continue;
    const adapter = createAdapter(
      server.serverType as ServerType,
      server.serverUrl,
      server.serverToken,
    );
    if (!supportsLiveSocket(adapter)) continue;
    const socket = adapter.liveSocket();
    if (!socket) continue;
    connect(server.id, server.label, socket.url, socket.hello);
  }
}

/**
 * Called once at process start from instrumentation.ts. Idempotent, because Next.js can
 * run the instrumentation hook more than once in development.
 */
export function startLive(): void {
  if (started) return;
  started = true;

  const tick = () => {
    void refreshListeners().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[watcharr] live listeners could not be refreshed: ${message}`);
    });
    // The safety net, and also what keeps the background work in sync.ts — monitoring, the
    // digest, the newsletter, retention — running on a server nobody is looking at.
    void syncActivity().catch(() => {});
  };

  timer = setInterval(tick, FALLBACK_MS);
  // Never the reason the process stays alive; Next.js owns the event loop.
  timer.unref?.();
  tick();
}

function closeSockets(): void {
  for (const [, listener] of listeners) listener.socket.close();
  listeners.clear();
}

export function stopLive(): void {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
  closeSockets();
}

/** For the system page: which servers currently have an open socket. */
export function liveServerIds(): number[] {
  return [...listeners.keys()];
}
