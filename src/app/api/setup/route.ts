import { NextResponse } from 'next/server';
import { createAdapter, SERVER_TYPES, type ServerType } from '@/server/adapters';
import { createServer, isConfigured, listServers, updateSettings } from '@/server/config';

export async function GET() {
  const servers = await listServers();
  return NextResponse.json({
    configured: servers.length > 0,
    serverType: servers[0]?.serverType ?? null,
  });
}

/**
 * First-run setup for the first server. Refuses to run again once one exists — further
 * servers are added from the admin area, which requires a global admin.
 */
export async function POST(request: Request) {
  if (await isConfigured()) {
    return NextResponse.json({ error: 'Already configured' }, { status: 409 });
  }

  const body = (await request.json()) as {
    serverType?: string;
    serverUrl?: string;
    serverToken?: string;
    tmdbApiKey?: string;
    label?: string;
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

  await createServer({
    serverType,
    serverUrl: body.serverUrl,
    serverToken: body.serverToken,
    serverName: health.serverName,
    label: body.label,
  });
  if (body.tmdbApiKey) await updateSettings({ tmdbApiKey: body.tmdbApiKey });
  return NextResponse.json({ ok: true, serverName: health.serverName });
}
