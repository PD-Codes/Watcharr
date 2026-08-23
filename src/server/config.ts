import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig } from '@/db/schema';
import { createAdapter, type MediaServerAdapter, type ServerType } from './adapters';
import { decryptSecret, encryptSecret } from './crypto';

export type AppConfig = typeof appConfig.$inferSelect;

/** Returns the single configuration row, or null while the deployment is not set up yet. */
export async function getConfig(): Promise<AppConfig | null> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.id, 1));
  if (!row) return null;
  return {
    ...row,
    serverToken: decryptSecret(row.serverToken),
    tmdbApiKey: row.tmdbApiKey ? decryptSecret(row.tmdbApiKey) : null,
  };
}

export async function requireConfig(): Promise<AppConfig> {
  const cfg = await getConfig();
  if (!cfg) throw new Error('Watcharr is not configured yet');
  return cfg;
}

/** Adapter bound to the configured server, using the stored admin token by default. */
export async function getAdapter(): Promise<MediaServerAdapter> {
  const cfg = await requireConfig();
  return createAdapter(cfg.serverType as ServerType, cfg.serverUrl, cfg.serverToken);
}

export async function saveConfig(input: {
  serverType: ServerType;
  serverUrl: string;
  serverToken: string;
  serverName?: string;
  tmdbApiKey?: string;
}) {
  const values = {
    ...input,
    serverToken: encryptSecret(input.serverToken),
    tmdbApiKey: input.tmdbApiKey ? encryptSecret(input.tmdbApiKey) : null,
  };
  await db
    .insert(appConfig)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: appConfig.id, set: values });
}

/** Partial update from the admin configuration page. */
export async function updateConfig(input: {
  serverUrl?: string;
  serverToken?: string;
  tmdbApiKey?: string | null;
  features?: Record<string, boolean>;
}) {
  const patch: Partial<typeof appConfig.$inferInsert> = {};
  if (input.serverUrl) patch.serverUrl = input.serverUrl;
  if (input.serverToken) patch.serverToken = encryptSecret(input.serverToken);
  if (input.tmdbApiKey !== undefined) {
    patch.tmdbApiKey = input.tmdbApiKey ? encryptSecret(input.tmdbApiKey) : null;
  }
  if (input.features) patch.features = input.features;
  if (Object.keys(patch).length) {
    await db.update(appConfig).set(patch).where(eq(appConfig.id, 1));
  }
}
