import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig, appSettings, users } from '@/db/schema';
import { createAdapter, type MediaServerAdapter, type ServerType } from './adapters';
import { decryptSecret, encryptSecret } from './crypto';

export type ServerRow = typeof appConfig.$inferSelect;

/** Slugs appear in URLs (the artwork proxy above all) and are validated on the way in. */
export const SERVER_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'server';
}

/** Appends a counter until the slug is free. Two servers may share a label, not a slug. */
async function uniqueSlug(label: string, exceptId?: number): Promise<string> {
  const taken = new Set(
    (await db.select({ slug: appConfig.slug, id: appConfig.id }).from(appConfig))
      .filter((row) => row.id !== exceptId)
      .map((row) => row.slug),
  );
  const base = slugify(label);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const decrypt = (row: ServerRow): ServerRow => ({
  ...row,
  serverToken: decryptSecret(row.serverToken),
});

/** Every configured media server, oldest first. Tokens are decrypted. */
export async function listServers(): Promise<ServerRow[]> {
  const rows = await db.select().from(appConfig).orderBy(asc(appConfig.id));
  return rows.map(decrypt);
}

export async function isConfigured(): Promise<boolean> {
  const [row] = await db.select({ id: appConfig.id }).from(appConfig).limit(1);
  return Boolean(row);
}

export async function getServer(id: number): Promise<ServerRow | null> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.id, id));
  return row ? decrypt(row) : null;
}

export async function getServerBySlug(slug: string): Promise<ServerRow | null> {
  if (!SERVER_SLUG.test(slug)) return null;
  const [row] = await db.select().from(appConfig).where(eq(appConfig.slug, slug));
  return row ? decrypt(row) : null;
}

export async function requireServer(id: number): Promise<ServerRow> {
  const server = await getServer(id);
  if (!server) throw new Error(`No media server with id ${id}`);
  return server;
}

/** Adapter bound to one server, using its stored admin token by default. */
export async function getAdapter(serverId: number): Promise<MediaServerAdapter> {
  const server = await requireServer(serverId);
  return createAdapter(server.serverType as ServerType, server.serverUrl, server.serverToken);
}

export async function createServer(input: {
  serverType: ServerType;
  serverUrl: string;
  serverToken: string;
  serverName?: string;
  label?: string;
}): Promise<ServerRow> {
  const label = input.label?.trim() || input.serverName?.trim() || 'Media Server';
  const [row] = await db
    .insert(appConfig)
    .values({
      serverType: input.serverType,
      serverUrl: input.serverUrl,
      serverToken: encryptSecret(input.serverToken),
      serverName: input.serverName,
      label,
      slug: await uniqueSlug(label),
    })
    .returning();
  return decrypt(row);
}

export async function updateServer(
  id: number,
  input: { serverUrl?: string; serverToken?: string; label?: string },
): Promise<void> {
  const patch: Partial<typeof appConfig.$inferInsert> = {};
  if (input.serverUrl) patch.serverUrl = input.serverUrl;
  if (input.serverToken) patch.serverToken = encryptSecret(input.serverToken);
  if (input.label?.trim()) {
    patch.label = input.label.trim();
    patch.slug = await uniqueSlug(patch.label, id);
  }
  if (Object.keys(patch).length) {
    await db.update(appConfig).set(patch).where(eq(appConfig.id, id));
  }
}

/**
 * Users carry no foreign key to app_config — SQLite cannot add one with ALTER TABLE — so
 * their rows are removed here. Everything below a user (history, sessions, watchlist) does
 * cascade from there.
 */
export async function deleteServer(id: number): Promise<void> {
  await db.delete(users).where(eq(users.serverId, id));
  await db.delete(appConfig).where(eq(appConfig.id, id));
}

export interface AppSettings {
  tmdbApiKey: string | null;
  features: Record<string, boolean>;
  /** Percentage of an item that counts as finished. Tautulli's default is 85. */
  watchedThreshold: number;
  webhookUrl: string | null;
  webhookEvents: string[];
  geoipEnabled: boolean;
  geoipUrl: string | null;
  monitorMaxStreamsPerUser: number | null;
  monitorBandwidthMbps: number | null;
  monitorTranscodeAlert: boolean;
  monitorFailedLoginThreshold: number | null;
  monitorFailedLoginWindowMin: number;
  digestEnabled: boolean;
  digestFrequency: string;
  digestLastSentAt: Date | null;
  backupAutoEnabled: boolean;
  backupIntervalHours: number;
  backupRetention: number;
  backupLastAt: Date | null;
  newsletterEnabled: boolean;
  newsletterDayOfWeek: number;
  newsletterHour: number;
  newsletterDays: number;
  newsletterLibraries: string[];
  newsletterSubject: string;
  newsletterIntro: string;
  newsletterUniqueId: string;
  newsletterLastSentAt: Date | null;
  newsletterLastHtml: string | null;
  updateCheckedAt: Date | null;
  updateLatestVersion: string | null;
}

const DEFAULT_SETTINGS: AppSettings = {
  tmdbApiKey: null,
  features: {},
  watchedThreshold: 85,
  webhookUrl: null,
  webhookEvents: [],
  geoipEnabled: false,
  geoipUrl: null,
  monitorMaxStreamsPerUser: null,
  monitorBandwidthMbps: null,
  monitorTranscodeAlert: false,
  monitorFailedLoginThreshold: null,
  monitorFailedLoginWindowMin: 10,
  digestEnabled: false,
  digestFrequency: 'weekly',
  digestLastSentAt: null,
  backupAutoEnabled: false,
  backupIntervalHours: 24,
  backupRetention: 7,
  backupLastAt: null,
  newsletterEnabled: false,
  newsletterDayOfWeek: 5,
  newsletterHour: 11,
  newsletterDays: 7,
  newsletterLibraries: [],
  newsletterSubject: 'Recently added',
  newsletterIntro: '',
  newsletterUniqueId: 'newsletter',
  newsletterLastSentAt: null,
  newsletterLastHtml: null,
  updateCheckedAt: null,
  updateLatestVersion: null,
};

/** Deployment-wide settings. The row is created on first write, not at setup time. */
export async function getSettings(): Promise<AppSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  if (!row) return DEFAULT_SETTINGS;
  return {
    tmdbApiKey: row.tmdbApiKey ? decryptSecret(row.tmdbApiKey) : null,
    features: row.features,
    watchedThreshold: row.watchedThreshold,
    webhookUrl: row.webhookUrl,
    webhookEvents: row.webhookEvents,
    geoipEnabled: row.geoipEnabled,
    geoipUrl: row.geoipUrl,
    monitorMaxStreamsPerUser: row.monitorMaxStreamsPerUser,
    monitorBandwidthMbps: row.monitorBandwidthMbps,
    monitorTranscodeAlert: row.monitorTranscodeAlert,
    monitorFailedLoginThreshold: row.monitorFailedLoginThreshold,
    monitorFailedLoginWindowMin: row.monitorFailedLoginWindowMin,
    digestEnabled: row.digestEnabled,
    digestFrequency: row.digestFrequency,
    digestLastSentAt: row.digestLastSentAt,
    backupAutoEnabled: row.backupAutoEnabled,
    backupIntervalHours: row.backupIntervalHours,
    backupRetention: row.backupRetention,
    backupLastAt: row.backupLastAt,
    newsletterEnabled: row.newsletterEnabled,
    newsletterDayOfWeek: row.newsletterDayOfWeek,
    newsletterHour: row.newsletterHour,
    newsletterDays: row.newsletterDays,
    newsletterLibraries: row.newsletterLibraries,
    newsletterSubject: row.newsletterSubject,
    newsletterIntro: row.newsletterIntro,
    newsletterUniqueId: row.newsletterUniqueId,
    newsletterLastSentAt: row.newsletterLastSentAt,
    newsletterLastHtml: row.newsletterLastHtml,
    updateCheckedAt: row.updateCheckedAt,
    updateLatestVersion: row.updateLatestVersion,
  };
}

export async function updateSettings(input: {
  tmdbApiKey?: string | null;
  features?: Record<string, boolean>;
  watchedThreshold?: number;
  webhookUrl?: string | null;
  webhookEvents?: string[];
  geoipEnabled?: boolean;
  geoipUrl?: string | null;
  monitorMaxStreamsPerUser?: number | null;
  monitorBandwidthMbps?: number | null;
  monitorTranscodeAlert?: boolean;
  monitorFailedLoginThreshold?: number | null;
  monitorFailedLoginWindowMin?: number;
  digestEnabled?: boolean;
  digestFrequency?: string;
  digestLastSentAt?: Date;
  backupAutoEnabled?: boolean;
  backupIntervalHours?: number;
  backupRetention?: number;
  backupLastAt?: Date;
  newsletterEnabled?: boolean;
  newsletterDayOfWeek?: number;
  newsletterHour?: number;
  newsletterDays?: number;
  newsletterLibraries?: string[];
  newsletterSubject?: string;
  newsletterIntro?: string;
  newsletterUniqueId?: string;
  newsletterLastSentAt?: Date;
  newsletterLastHtml?: string;
  updateCheckedAt?: Date;
  updateLatestVersion?: string | null;
}): Promise<void> {
  const patch: Partial<typeof appSettings.$inferInsert> = {};
  if (input.tmdbApiKey !== undefined) {
    patch.tmdbApiKey = input.tmdbApiKey ? encryptSecret(input.tmdbApiKey) : null;
  }
  if (input.features) patch.features = input.features;
  if (input.watchedThreshold !== undefined) {
    // Clamped rather than rejected: the value only shifts a boundary, and a nonsensical
    // one would silently make every completion statistic meaningless.
    patch.watchedThreshold = Math.min(100, Math.max(1, Math.round(input.watchedThreshold)));
  }
  if (input.webhookUrl !== undefined) {
    // Only http(s): a webhook is an outbound request from the server, so file: or other
    // schemes would be handing an admin-supplied URL straight to fetch.
    const url = input.webhookUrl?.trim();
    patch.webhookUrl = url && /^https?:\/\//i.test(url) ? url : null;
  }
  if (input.webhookEvents) patch.webhookEvents = input.webhookEvents;
  if (input.geoipEnabled !== undefined) patch.geoipEnabled = input.geoipEnabled;
  if (input.geoipUrl !== undefined) {
    const url = input.geoipUrl?.trim();
    patch.geoipUrl = url && /^https?:\/\//i.test(url) ? url : null;
  }
  if (input.monitorMaxStreamsPerUser !== undefined) {
    patch.monitorMaxStreamsPerUser =
      input.monitorMaxStreamsPerUser && input.monitorMaxStreamsPerUser > 0
        ? Math.round(input.monitorMaxStreamsPerUser)
        : null;
  }
  if (input.monitorBandwidthMbps !== undefined) {
    patch.monitorBandwidthMbps =
      input.monitorBandwidthMbps && input.monitorBandwidthMbps > 0
        ? Math.round(input.monitorBandwidthMbps)
        : null;
  }
  if (input.monitorTranscodeAlert !== undefined) {
    patch.monitorTranscodeAlert = input.monitorTranscodeAlert;
  }
  if (input.monitorFailedLoginThreshold !== undefined) {
    patch.monitorFailedLoginThreshold =
      input.monitorFailedLoginThreshold && input.monitorFailedLoginThreshold > 0
        ? Math.round(input.monitorFailedLoginThreshold)
        : null;
  }
  if (input.monitorFailedLoginWindowMin !== undefined) {
    patch.monitorFailedLoginWindowMin = Math.max(1, Math.round(input.monitorFailedLoginWindowMin));
  }
  if (input.digestEnabled !== undefined) patch.digestEnabled = input.digestEnabled;
  if (input.digestFrequency !== undefined) {
    patch.digestFrequency = input.digestFrequency === 'daily' ? 'daily' : 'weekly';
  }
  if (input.digestLastSentAt) patch.digestLastSentAt = input.digestLastSentAt;
  if (input.backupAutoEnabled !== undefined) patch.backupAutoEnabled = input.backupAutoEnabled;
  if (input.backupIntervalHours !== undefined) {
    patch.backupIntervalHours = Math.max(1, Math.round(input.backupIntervalHours));
  }
  if (input.backupRetention !== undefined) {
    patch.backupRetention = Math.max(1, Math.round(input.backupRetention));
  }
  if (input.backupLastAt) patch.backupLastAt = input.backupLastAt;
  if (input.newsletterEnabled !== undefined) patch.newsletterEnabled = input.newsletterEnabled;
  if (input.newsletterDayOfWeek !== undefined) {
    patch.newsletterDayOfWeek = Math.min(6, Math.max(0, Math.round(input.newsletterDayOfWeek)));
  }
  if (input.newsletterHour !== undefined) {
    patch.newsletterHour = Math.min(23, Math.max(0, Math.round(input.newsletterHour)));
  }
  if (input.newsletterDays !== undefined) {
    patch.newsletterDays = Math.min(90, Math.max(1, Math.round(input.newsletterDays)));
  }
  if (input.newsletterLibraries) patch.newsletterLibraries = input.newsletterLibraries;
  if (input.newsletterSubject !== undefined) {
    patch.newsletterSubject = input.newsletterSubject.trim().slice(0, 200) || 'Recently added';
  }
  if (input.newsletterIntro !== undefined) {
    patch.newsletterIntro = input.newsletterIntro.slice(0, 2000);
  }
  if (input.newsletterUniqueId !== undefined) {
    // Goes straight into a URL path segment, so it is filtered rather than escaped.
    const id = input.newsletterUniqueId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    patch.newsletterUniqueId = id || 'newsletter';
  }
  if (input.newsletterLastSentAt) patch.newsletterLastSentAt = input.newsletterLastSentAt;
  if (input.newsletterLastHtml !== undefined) patch.newsletterLastHtml = input.newsletterLastHtml;
  if (input.updateCheckedAt) patch.updateCheckedAt = input.updateCheckedAt;
  if (input.updateLatestVersion !== undefined) patch.updateLatestVersion = input.updateLatestVersion;
  if (!Object.keys(patch).length) return;

  await db
    .insert(appSettings)
    .values({ id: 1, ...patch })
    .onConflictDoUpdate({ target: appSettings.id, set: patch });
}
