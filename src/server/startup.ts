import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_PATH, dbInfo } from '@/db';
import { readerStatus } from '@/db/readers';
import { getSettings, listServers } from './config';

/**
 * A few lines at start-up that say what this instance is running with. Next prints "Ready"
 * and nothing else, so a container log that looked empty told an operator nothing — not which
 * database, not which servers, not whether the background sync was on.
 */
export async function logStartup(): Promise<void> {
  let version = '?';
  try {
    version = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version ?? '?';
  } catch {
    // The standalone build ships its own package.json; without one the version is just unknown.
  }
  const info = dbInfo();
  const readers = readerStatus();
  const [servers, settings] = await Promise.all([listServers(), getSettings()]);
  const background = process.env.WATCHARR_NO_BACKGROUND === '1' ? 'off (WATCHARR_NO_BACKGROUND=1)' : 'on';
  const lines = [
    `Watcharr ${version} on Node ${process.versions.node}`,
    `database: ${DB_PATH} (journal ${info.journalMode}, locking ${info.locking}` +
      `${info.remoteFs ? `, on ${info.remoteFs}` : ''}, ${readers ? `${readers.size} parallel readers` : 'no parallel readers'})`,
    `servers: ${servers.length ? servers.map((s) => `${s.label} [${s.serverType}]`).join(', ') : 'none yet (open the app to set one up)'}`,
    `time zone: ${settings.timezone ?? process.env.TZ ?? 'UTC'} · TMDB: ${settings.tmdbApiKey ? 'on' : 'off'} · background sync: ${background}`,
    `log: slow jobs and state changes; WATCHARR_LOG=debug lists every sync run`,
  ];
  for (const line of lines) console.log(`[watcharr] ${line}`);
}
