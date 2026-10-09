import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { updateSettings } from '@/server/config';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Deployment-wide settings. Server connection details live under /api/admin/servers. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const body = await readBody(request, {
    tmdbApiKey: 'string',
    defaultLocale: 'string',
    features: 'flags',
    watchedThreshold: 'number',
    webhookUrl: 'string',
    webhookEvents: 'strings',
    geoipEnabled: 'boolean',
    geoipUrl: 'string',
    monitorMaxStreamsPerUser: 'number',
    monitorBandwidthMbps: 'number',
    monitorTranscodeAlert: 'boolean',
    monitorFailedLoginThreshold: 'number',
    monitorFailedLoginWindowMin: 'number',
    monitorNewAddressAlert: 'boolean',
    digestEnabled: 'boolean',
    digestFrequency: 'string',
    backupAutoEnabled: 'boolean',
    backupIntervalHours: 'number',
    backupRetention: 'number',
    timezone: 'string',
    retentionSessionDays: 'number',
    retentionLogDays: 'number',
    retentionHistoryDays: 'number',
  });
  if (!body) return badBody();

  const threshold = Number(body.watchedThreshold);
  await updateSettings({
    tmdbApiKey: body.tmdbApiKey === undefined ? undefined : body.tmdbApiKey || null,
    defaultLocale: body.defaultLocale ?? undefined,
    features: body.features ?? undefined,
    watchedThreshold: Number.isFinite(threshold) ? threshold : undefined,
    webhookUrl: body.webhookUrl === undefined ? undefined : body.webhookUrl || null,
    webhookEvents: body.webhookEvents ?? undefined,
    geoipEnabled: body.geoipEnabled ?? undefined,
    geoipUrl: body.geoipUrl === undefined ? undefined : body.geoipUrl || null,
    monitorMaxStreamsPerUser:
      body.monitorMaxStreamsPerUser === undefined ? undefined : body.monitorMaxStreamsPerUser,
    monitorBandwidthMbps:
      body.monitorBandwidthMbps === undefined ? undefined : body.monitorBandwidthMbps,
    monitorTranscodeAlert: body.monitorTranscodeAlert ?? undefined,
    monitorFailedLoginThreshold:
      body.monitorFailedLoginThreshold === undefined ? undefined : body.monitorFailedLoginThreshold,
    monitorFailedLoginWindowMin: body.monitorFailedLoginWindowMin ?? undefined,
    monitorNewAddressAlert: body.monitorNewAddressAlert ?? undefined,
    digestEnabled: body.digestEnabled ?? undefined,
    digestFrequency: body.digestFrequency ?? undefined,
    backupAutoEnabled: body.backupAutoEnabled ?? undefined,
    backupIntervalHours: body.backupIntervalHours ?? undefined,
    backupRetention: body.backupRetention ?? undefined,
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
