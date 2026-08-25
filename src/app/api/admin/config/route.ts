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
    digestEnabled?: boolean;
    digestFrequency?: string;
    backupAutoEnabled?: boolean;
    backupIntervalHours?: number;
    backupRetention?: number;
  };

  const threshold = Number(body.watchedThreshold);
  await updateSettings({
    tmdbApiKey: body.tmdbApiKey === undefined ? undefined : body.tmdbApiKey || null,
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
    digestEnabled: typeof body.digestEnabled === 'boolean' ? body.digestEnabled : undefined,
    digestFrequency: body.digestFrequency,
    backupAutoEnabled: typeof body.backupAutoEnabled === 'boolean' ? body.backupAutoEnabled : undefined,
    backupIntervalHours: body.backupIntervalHours,
    backupRetention: body.backupRetention,
  });
  return NextResponse.json({ ok: true });
}
