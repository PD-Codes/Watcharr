import { NextResponse } from 'next/server';
import { createAdapter, SERVER_TYPES, type ServerType } from '@/server/adapters';
import { createServer, deleteServer, getServer, listServers, updateServer } from '@/server/config';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Server management is global-admin only. A server admin who could add a server would be
 * able to grant themselves admin rights on a machine they control, and with them a second
 * account inside this deployment — which is exactly the boundary the role is meant to draw.
 */
async function requireGlobal() {
  const session = await getSession();
  return session?.user.globalAdmin ? session : null;
}

export async function POST(request: Request) {
  if (!(await requireGlobal())) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const body = (await request.json()) as {
    serverType?: string;
    serverUrl?: string;
    serverToken?: string;
    label?: string;
  };

  if (!body.serverType || !SERVER_TYPES.includes(body.serverType as ServerType)) {
    return NextResponse.json({ error: 'Invalid server type' }, { status: 400 });
  }
  if (!body.serverUrl?.startsWith('http') || !body.serverToken) {
    return NextResponse.json({ error: 'Server URL and token are required' }, { status: 400 });
  }

  const serverType = body.serverType as ServerType;
  const health = await createAdapter(serverType, body.serverUrl, body.serverToken)
    .ping()
    .catch(() => ({ ok: false }));
  if (!health.ok) {
    return NextResponse.json({ error: 'Could not reach the media server' }, { status: 400 });
  }

  const server = await createServer({
    serverType,
    serverUrl: body.serverUrl,
    serverToken: body.serverToken,
    serverName: 'serverName' in health ? health.serverName : undefined,
    label: body.label,
  });
  return NextResponse.json({ ok: true, id: server.id, slug: server.slug });
}

export async function PATCH(request: Request) {
  if (!(await requireGlobal())) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const body = (await request.json()) as {
    id?: number;
    serverUrl?: string;
    serverToken?: string;
    label?: string;
  };
  const current = body.id ? await getServer(body.id) : null;
  if (!current) return NextResponse.json({ error: 'Unknown server' }, { status: 404 });

  // Never persist connection details that do not actually work.
  if (body.serverUrl || body.serverToken) {
    const probe = createAdapter(
      current.serverType as ServerType,
      body.serverUrl || current.serverUrl,
      body.serverToken || current.serverToken,
    );
    if (!(await probe.ping().catch(() => ({ ok: false }))).ok) {
      return NextResponse.json({ error: 'Could not reach the media server' }, { status: 400 });
    }
  }

  await updateServer(current.id, {
    serverUrl: body.serverUrl,
    serverToken: body.serverToken,
    label: body.label,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await requireGlobal();
  if (!session) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const { id } = (await request.json()) as { id?: number };
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  if (id === session.user.serverId) {
    return NextResponse.json(
      { error: 'You cannot remove the server you are signed in through' },
      { status: 400 },
    );
  }
  if ((await listServers()).length < 2) {
    return NextResponse.json({ error: 'The last server cannot be removed' }, { status: 400 });
  }

  await deleteServer(id);
  return NextResponse.json({ ok: true });
}
