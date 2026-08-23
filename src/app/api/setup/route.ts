import { NextResponse } from 'next/server';
import { createAdapter, SERVER_TYPES, type ServerType } from '@/server/adapters';
import { getConfig, saveConfig } from '@/server/config';

export async function GET() {
  const cfg = await getConfig();
  return NextResponse.json({ configured: Boolean(cfg), serverType: cfg?.serverType ?? null });
}

/** First-run setup. Refuses to run again once a configuration exists. */
export async function POST(request: Request) {
  if (await getConfig()) {
    return NextResponse.json({ error: 'Already configured' }, { status: 409 });
  }

  const body = (await request.json()) as {
    serverType?: string;
    serverUrl?: string;
    serverToken?: string;
    tmdbApiKey?: string;
  };

  if (!body.serverType || !SERVER_TYPES.includes(body.serverType as ServerType)) {
    return NextResponse.json({ error: 'Invalid server type' }, { status: 400 });
  }
  if (!body.serverUrl?.startsWith('http') || !body.serverToken) {
    return NextResponse.json({ error: 'Server URL and token are required' }, { status: 400 });
  }

  const serverType = body.serverType as ServerType;
  const adapter = createAdapter(serverType, body.serverUrl, body.serverToken);
  const health = await adapter.ping();
  if (!health.ok) {
    return NextResponse.json({ error: 'Could not reach the media server' }, { status: 400 });
  }

  await saveConfig({
    serverType,
    serverUrl: body.serverUrl,
    serverToken: body.serverToken,
    serverName: health.serverName,
    tmdbApiKey: body.tmdbApiKey || undefined,
  });
  return NextResponse.json({ ok: true, serverName: health.serverName });
}
