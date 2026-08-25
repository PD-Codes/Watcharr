import 'server-only';
import { isEnabled } from './features';
import { updateSettings, type AppSettings } from './config';
import pkg from '../../package.json';

// Update check against the public release feed of the upstream repository.
// The result is cached in app_config because the admin system page auto-refreshes every
// 30 seconds, and GitHub allows 60 unauthenticated requests per hour — without the cache
// a single open browser tab would exhaust that within half an hour.

const RELEASES_API = 'https://api.github.com/repos/PD-Codes/Watcharr/releases/latest';
export const RELEASES_PAGE = 'https://github.com/PD-Codes/Watcharr/releases';

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;

export const currentVersion: string = pkg.version;

export interface UpdateStatus {
  current: string;
  /** Newest published release, or null while unknown (disabled, or never reached). */
  latest: string | null;
  outdated: boolean;
  checkedAt: Date | null;
  enabled: boolean;
}

/**
 * Numeric comparison of dotted versions. Returns <0, 0 or >0 like a sort comparator.
 * A leading "v" and any pre-release suffix are ignored, so "v1.2.0-rc1" compares as 1.2.0.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);

  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

async function fetchLatestRelease(): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_API, {
      // GitHub rejects requests without a user agent.
      headers: { accept: 'application/vnd.github+json', 'user-agent': `watcharr/${currentVersion}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const tag = (body as { tag_name?: unknown }).tag_name;
    return typeof tag === 'string' && tag ? tag : null;
  } catch {
    // A GitHub outage must never break the system status page.
    return null;
  }
}

export async function getUpdateStatus(settings: AppSettings): Promise<UpdateStatus> {
  const current = currentVersion;
  if (!isEnabled(settings.features, 'updateCheck')) {
    return { current, latest: null, outdated: false, checkedAt: null, enabled: false };
  }

  let latest = settings.updateLatestVersion;
  let checkedAt = settings.updateCheckedAt;

  if (!checkedAt || Date.now() - checkedAt.getTime() > CHECK_EVERY_MS) {
    const fetched = await fetchLatestRelease();
    // The attempt is recorded even when it failed, so an unreachable GitHub does not turn
    // every page render into another outbound request. Cost is a delayed discovery.
    checkedAt = new Date();
    if (fetched) latest = fetched;
    await updateSettings({ updateCheckedAt: checkedAt, updateLatestVersion: latest });
  }

  return {
    current,
    latest,
    outdated: latest !== null && compareVersions(latest, current) > 0,
    checkedAt,
    enabled: true,
  };
}
