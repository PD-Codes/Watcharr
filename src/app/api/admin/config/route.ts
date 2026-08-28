import { NextResponse } from 'next/server';
import { updateSettings } from '@/server/config';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Deployment-wide settings. Server connection details live under /api/admin/servers. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const body = (await request.json()) as {
    tmdbApiKey?: string;
    defaultLocale?: string;
    features?: Record<string, boolean>;
    watchedThreshold?: number;
    webhookUrl?: string;
    webhookEvents?: string[];
    geoipEnabled?: boolean;
    geoipUrl?: string;
    monitorMaxStreamsPerUser?: number | null;
    monitorBandwidthMbps?: number | null;
    monitorTranscodeAlert?: boolean;
    monitorFailedLoginThreshold?: number | null;
    monitorFailedLoginWindowMin?: number;
    monitorNewAddressAlert?: boolean;
    digestEnabled?: boolean;
    digestFrequency?: string;
    backupAutoEnabled?: boolean;
    backupIntervalHours?: number;
    backupRetention?: number;
    timezone?: string;
    retentionSessionDays?: number | null;
    retentionLogDays?: number | null;
    retentionHistoryDays?: number | null;
  };

  const threshold = Number(body.watchedThreshold);
  await updateSettings({
    tmdbApiKey: body.tmdbApiKey === undefined ? undefined : body.tmdbApiKey || null,
    defaultLocale: body.defaultLocale,
    features: body.features,
    watchedThreshold: Number.isFinite(threshold) ? threshold : undefined,
    webhookUrl: body.webhookUrl === undefined ? undefined : body.webhookUrl || null,
    webhookEvents: Array.isArray(body.webhookEvents)
      ? body.webhookEvents.filter((e): e is string => typeof e === 'string')
      : undefined,
    geoipEnabled: typeof body.geoipEnabled === 'boolean' ? body.geoipEnabled : undefined,
    geoipUrl: body.geoipUrl === undefined ? undefined : body.geoipUrl || null,
    monitorMaxStreamsPerUser:
      body.monitorMaxStreamsPerUser === undefined ? undefined : body.monitorMaxStreamsPerUser,
    monitorBandwidthMbps:
      body.monitorBandwidthMbps === undefined ? undefined : body.monitorBandwidthMbps,
    monitorTranscodeAlert:
      typeof body.monitorTranscodeAlert === 'boolean' ? body.monitorTranscodeAlert : undefined,
    monitorFailedLoginThreshold:
      body.monitorFailedLoginThreshold === undefined ? undefined : body.monitorFailedLoginThreshold,
    monitorFailedLoginWindowMin:
      body.monitorFailedLoginWindowMin === undefined ? undefined : body.monitorFailedLoginWindowMin,
    monitorNewAddressAlert:
      typeof body.monitorNewAddressAlert === 'boolean' ? body.monitorNewAddressAlert : undefined,
    digestEnabled: typeof body.digestEnabled === 'boolean' ? body.digestEnabled : undefined,
    digestFrequency: body.digestFrequency,
    backupAutoEnabled: typeof body.backupAutoEnabled === 'boolean' ? body.backupAutoEnabled : undefined,
    backupIntervalHours: body.backupIntervalHours,
    backupRetention: body.backupRetention,
    // The empty option means "follow the container", so an empty string is a value here
    // rather than an omission — hence null instead of undefined.
    timezone: body.timezone === undefined ? undefined : body.timezone || null,
    retentionSessionDays:
      body.retentionSessionDays === undefined ? undefined : body.retentionSessionDays,
    retentionLogDays: body.retentionLogDays === undefined ? undefined : body.retentionLogDays,
    retentionHistoryDays:
      body.retentionHistoryDays === undefined ? undefined : body.retentionHistoryDays,
  });
  // The API key is deliberately not settable here: it is issued by /api/admin/apikey and
  // returned once, never round-tripped through a form that would put it in a page payload.
  return NextResponse.json({ ok: true });
}
