import { NextResponse } from 'next/server';
import { createAdapter, type ServerType } from '@/server/adapters';
import { getConfig, updateConfig } from '@/server/config';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const current = await getConfig();
  if (!current) return NextResponse.json({ error: 'Not configured' }, { status: 409 });

  const body = (await request.json()) as {
    serverUrl?: string;
    serverToken?: string;
    tmdbApiKey?: string;
    features?: Record<string, boolean>;
  };

  // Never persist connection details that do not actually work.
  const serverUrl = body.serverUrl || current.serverUrl;
  const serverToken = body.serverToken || current.serverToken;
  if (body.serverUrl || body.serverToken) {
    const probe = createAdapter(current.serverType as ServerType, serverUrl, serverToken);
    if (!(await probe.ping()).ok) {
      return NextResponse.json({ error: 'Could not reach the media server' }, { status: 400 });
    }
  }

  await updateConfig({
    serverUrl: body.serverUrl,
    serverToken: body.serverToken,
    tmdbApiKey: body.tmdbApiKey === undefined ? undefined : body.tmdbApiKey || null,
    features: body.features,
  });
  return NextResponse.json({ ok: true });
}
