import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { createAdapter, SERVER_TYPES, type ServerType } from '@/server/adapters';
import { createFirstServer, isConfigured, listServers, updateSettings } from '@/server/config';
import { clientIp } from '@/server/ratelimit';
import { getRealSession } from '@/server/session';
import { checkSetupToken, setupTokenPending } from '@/server/setuptoken';

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

  const body = await readBody(request, {
    serverType: 'string',
    serverUrl: 'string',
    serverToken: 'string',
    tmdbApiKey: 'string',
    label: 'string',
    setupToken: 'string',
  });
  if (!body) return badBody();

  // Whoever finishes setup decides which server the admins come from, so it takes the one-time
  // token from the container log (or, if an admin still exists after every server was removed,
  // that admin). Without it, anyone reaching a fresh instance could point it at their own server
  // and sign in as its admin — the global admin role included.
  if (await setupTokenPending()) {
    const check = await checkSetupToken(body.setupToken, clientIp(request));
    if (check !== 'valid') {
      return NextResponse.json(
        { error: check === 'limited' ? 'Too many attempts, try again later' : 'The setup token from the server log is required', code: 'setup-token' },
        { status: check === 'limited' ? 429 : 401 },
      );
    }
  } else if (!(await getRealSession())?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

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

  const created = createFirstServer({
    serverType,
    serverUrl: body.serverUrl,
    serverToken: body.serverToken,
    serverName: health.serverName,
    label: body.label ?? undefined,
  });
  // Someone else finished setup while the media server was being pinged.
  if (!created) return NextResponse.json({ error: 'Already configured' }, { status: 409 });
  if (body.tmdbApiKey) await updateSettings({ tmdbApiKey: body.tmdbApiKey });
  return NextResponse.json({ ok: true, serverName: health.serverName });
}
