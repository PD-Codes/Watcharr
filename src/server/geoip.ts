import 'server-only';
import { reverse } from 'node:dns/promises';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { geoipCache } from '@/db/schema';
import { getSettings } from './config';
import { isPrivateAddress, normalise } from './net';

// Optional address lookup, treated exactly like TMDB: off unless an admin turns it on,
// and the app is fully usable without it. No MaxMind database is bundled — that would mean
// a licence key, a ~60 MB download and an update job inside the container.
//
// Providers disagree on field names, so each value is picked from a list of candidates
// rather than from one fixed shape. ipapi.co, ip-api.com and ipinfo.io all work with the
// same code, which is why the URL is a template instead of a hard-coded provider.

const TIMEOUT_MS = 4_000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IpDetails {
  ip: string;
  isLocal: boolean;
  country: string | null;
  continent: string | null;
  region: string | null;
  city: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
  isp: string | null;
  organisation: string | null;
  asn: string | null;
  host: string | null;
}

/** Field name candidates per property, most specific first. */
const FIELDS: Record<keyof Omit<IpDetails, 'ip' | 'isLocal' | 'host'>, string[]> = {
  country: ['country_name', 'countryName', 'country'],
  continent: ['continent_name', 'continentName', 'continent', 'continent_code'],
  region: ['region', 'region_name', 'regionName'],
  city: ['city'],
  postalCode: ['postal', 'postal_code', 'postalCode', 'zip'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lon', 'lng'],
  timezone: ['timezone', 'time_zone'],
  isp: ['isp', 'org', 'organisation', 'organization'],
  organisation: ['org', 'organisation', 'organization', 'asn_org'],
  asn: ['asn', 'as'],
};

function pick(body: Record<string, unknown>, candidates: string[]): string | null {
  for (const field of candidates) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/** Reverse DNS. Never fatal: plenty of addresses simply have no PTR record. */
async function lookupHost(ip: string): Promise<string | null> {
  try {
    const names = await Promise.race([
      reverse(ip),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), TIMEOUT_MS)),
    ]);
    return names[0] ?? null;
  } catch {
    return null;
  }
}

const empty = (ip: string, isLocal: boolean): IpDetails => ({
  ip,
  isLocal,
  country: null,
  continent: null,
  region: null,
  city: null,
  postalCode: null,
  latitude: null,
  longitude: null,
  timezone: null,
  isp: null,
  organisation: null,
  asn: null,
  host: null,
});

/**
 * Everything known about one address. Local addresses are never sent to a provider — they
 * would tell it nothing anyway — but they still get a reverse DNS lookup, which is what
 * turns a bare 192.168.x.x into a recognisable device name.
 */
export async function lookupIp(address: string, refresh = false): Promise<IpDetails> {
  const ip = normalise(address);
  if (!ip) return empty(address, false);
  const local = isPrivateAddress(ip);

  const [cached] = refresh
    ? []
    : await db.select().from(geoipCache).where(eq(geoipCache.ip, ip));
  if (cached && Date.now() - cached.fetchedAt.getTime() < TTL_MS) {
    return {
      ip,
      isLocal: local,
      country: cached.country,
      continent: cached.continent,
      region: cached.region,
      city: cached.city,
      postalCode: cached.postalCode,
      latitude: cached.latitude,
      longitude: cached.longitude,
      timezone: cached.timezone,
      isp: cached.isp,
      organisation: cached.organisation,
      asn: cached.asn,
      host: cached.host,
    };
  }

  const details = empty(ip, local);
  details.host = await lookupHost(ip);

  const { geoipEnabled, geoipUrl } = await getSettings();
  if (!local && geoipEnabled && geoipUrl?.includes('{ip}')) {
    try {
      const res = await fetch(geoipUrl.replace('{ip}', encodeURIComponent(ip)), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        for (const key of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) {
          details[key] = pick(body, FIELDS[key]);
        }
      }
    } catch {
      // A dead provider must not break the activity page.
    }
  }

  // Cached even when everything came back null, so an unreachable provider is not queried
  // again on every refresh of a page that auto-reloads every ten seconds.
  const row = { ...details, ip, fetchedAt: new Date() };
  const { isLocal: _ignored, ...columns } = row;
  await db.insert(geoipCache).values(columns).onConflictDoUpdate({ target: geoipCache.ip, set: columns });
  return details;
}

/**
 * Country for one address, or null when lookups are off, the address is local, or the
 * provider does not answer. Thin wrapper so the activity badge does not care that the
 * lookup now fetches a whole record.
 */
export async function lookupCountry(address: string): Promise<string | null> {
  const ip = normalise(address);
  if (!ip || isPrivateAddress(ip)) return null;
  const { geoipEnabled, geoipUrl } = await getSettings();
  if (!geoipEnabled || !geoipUrl?.includes('{ip}')) return null;
  return (await lookupIp(address)).country;
}
