import 'server-only';
import { getAdapter } from './config';
import { singleFlight } from './jobs';
import { globalState } from './state';

/**
 * The Plex machineIdentifier of a configured server, for callers outside this app that work on
 * the server directly and need to know which one an answer is about (the read-only API's
 * watchlist). Asked through the adapter's ping, which Plex answers from `/`.
 *
 * Kept in memory: the id only changes when Plex is reinstalled, so six hours is a long time to
 * be wrong only in theory. A server that does not answer is asked again after five minutes
 * instead of on every request, and an id once known survives a failed refresh.
 */
const KEEP_MS = 6 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;

const known = () => globalState('machineIdentifiers', () => new Map<number, { id: string | null; at: number }>());

export function machineIdentifier(serverId: number): Promise<string | null> {
  const cached = known().get(serverId);
  if (cached && Date.now() - cached.at < (cached.id ? KEEP_MS : RETRY_MS)) return Promise.resolve(cached.id);
  return singleFlight(`machine-id:${serverId}`, async () => {
    const answer = await getAdapter(serverId)
      .then((adapter) => adapter.ping())
      .catch(() => ({ ok: false as const, machineIdentifier: undefined }));
    const id = (answer.ok ? answer.machineIdentifier : undefined) ?? cached?.id ?? null;
    known().set(serverId, { id, at: Date.now() });
    return id;
  });
}
