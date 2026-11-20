import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { createAdapter, SERVER_TYPES, type ServerType } from '@/server/adapters';
import { createFirstServer, isConfigured, listServers, updateSettings } from '@/server/config';
import { clientIp } from '@/server/ratelimit';
import { getRealSession } from '@/server/session';
import { checkSetupToken, setupTokenPending } from '@/server/setuptoken';
import { apiError, badBody, globalAdminRequired, withApiErrors } from '@/server/apierror';

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
export const POST = withApiErrors(async (request: Request) => {
  if (await isConfigured()) {
    return apiError(409, 'already-configured', 'err.alreadyConfigured');
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
      return apiError(
        check === 'limited' ? 429 : 401,
        'setup-token',
        check === 'limited' ? 'err.limited' : 'err.setupTokenRequired',
      );
    }
  } else if (!(await getRealSession())?.user.globalAdmin) {
    return globalAdminRequired();
  }

  if (!body.serverType || !SERVER_TYPES.includes(body.serverType as ServerType)) {
    return apiError(400, 'invalid-server-type', 'err.invalidServerType');
  }
  if (!body.serverUrl?.startsWith('http') || !body.serverToken) {
    return apiError(400, 'missing-fields', 'err.serverFieldsRequired');
  }

  const serverType = body.serverType as ServerType;
  const adapter = createAdapter(serverType, body.serverUrl, body.serverToken);
  const health = await adapter.ping();
  if (!health.ok) {
    return apiError(400, 'server-unreachable', 'err.serverUnreachable');
  }

  const created = createFirstServer({
    serverType,
    serverUrl: body.serverUrl,
    serverToken: body.serverToken,
    serverName: health.serverName,
    label: body.label ?? undefined,
  });
  // Someone else finished setup while the media server was being pinged.
  if (!created) return apiError(409, 'already-configured', 'err.alreadyConfigured');
  if (body.tmdbApiKey) await updateSettings({ tmdbApiKey: body.tmdbApiKey });
  return NextResponse.json({ ok: true, serverName: health.serverName });
});
