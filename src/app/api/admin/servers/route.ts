import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { createAdapter, SERVER_TYPES, type ServerType } from '@/server/adapters';
import { createServer, deleteServer, getServer, listServers, updateServer } from '@/server/config';
import { sameEndpoint } from '@/server/notifications';
import { getGlobalAdminSession } from '@/server/session';
import { apiError, badBody, globalAdminRequired } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/*
 * Server management is global-admin only. A server admin who could add a server would be
 * able to grant themselves admin rights on a machine they control, and with them a second
 * account inside this deployment — which is exactly the boundary the role is meant to draw.
 */

export async function POST(request: Request) {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();

  const body = await readBody(request, {
    serverType: 'string',
    serverUrl: 'string',
    serverToken: 'string',
    label: 'string',
  });
  if (!body) return badBody();

  if (!body.serverType || !SERVER_TYPES.includes(body.serverType as ServerType)) {
    return apiError(400, 'invalid-server-type', 'err.invalidServerType');
  }
  if (!body.serverUrl?.startsWith('http') || !body.serverToken) {
    return apiError(400, 'missing-fields', 'err.serverFieldsRequired');
  }

  const serverType = body.serverType as ServerType;
  const health = await createAdapter(serverType, body.serverUrl, body.serverToken)
    .ping()
    .catch(() => ({ ok: false }));
  if (!health.ok) {
    return apiError(400, 'server-unreachable', 'err.serverUnreachable');
  }

  const server = await createServer({
    serverType,
    serverUrl: body.serverUrl,
    serverToken: body.serverToken,
    serverName: 'serverName' in health ? health.serverName : undefined,
    label: body.label ?? undefined,
  });
  return NextResponse.json({ ok: true, id: server.id, slug: server.slug });
}

export async function PATCH(request: Request) {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();

  const body = await readBody(request, {
    id: 'number',
    serverUrl: 'string',
    serverToken: 'string',
    label: 'string',
  });
  if (!body) return badBody();
  const current = body.id ? await getServer(body.id) : null;
  if (!current) return apiError(404, 'unknown-server', 'err.unknownServer');

  // The token field is never shown and blank means "keep it". Moving the address to another
  // scheme, host or port without entering the token again would send the stored admin token
  // there — the probe below alone does that, before anything is saved.
  if (body.serverUrl && !body.serverToken && !sameEndpoint(current.serverUrl, body.serverUrl)) {
    return apiError(400, 'token-required', 'err.serverTokenRequired');
  }

  // Never persist connection details that do not actually work.
  if (body.serverUrl || body.serverToken) {
    const probe = createAdapter(
      current.serverType as ServerType,
      body.serverUrl || current.serverUrl,
      body.serverToken || current.serverToken,
    );
    if (!(await probe.ping().catch(() => ({ ok: false }))).ok) {
      return apiError(400, 'server-unreachable', 'err.serverUnreachable');
    }
  }

  await updateServer(current.id, {
    serverUrl: body.serverUrl ?? undefined,
    serverToken: body.serverToken ?? undefined,
    label: body.label ?? undefined,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await getGlobalAdminSession();
  if (!session) return globalAdminRequired();

  const deleteBody = await readBody(request, { id: 'number' });
  if (!deleteBody) return badBody();
  const id = deleteBody.id;
  if (!id) return apiError(400, 'id-required', 'err.idRequired');
  if (id === session.user.serverId) {
    return apiError(400, 'server-in-use', 'err.serverInUse');
  }
  if ((await listServers()).length < 2) {
    return apiError(400, 'last-server', 'err.lastServer');
  }

  await deleteServer(id);
  return NextResponse.json({ ok: true });
}
