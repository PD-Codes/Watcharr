import { NextResponse } from 'next/server';
import { getServer } from '@/server/config';
import { getSession } from '@/server/session';
import { importFromTautulli } from '@/server/tautulli';

export const dynamic = 'force-dynamic';
// A few hundred thousand history rows take longer than a default route budget.
export const maxDuration = 300;

/**
 * Imports a Tautulli database into one media server's accounts.
 *
 * Global admin only, and the path is read from the container's own filesystem — this is
 * the one endpoint that opens a file the caller names, so it is fenced by the strongest
 * role in the app rather than by validation of the path itself. A server admin can already
 * see everything on their server; being able to name a file on the host is a different
 * kind of power and belongs with whoever runs the deployment.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    path?: string;
    serverId?: number;
    dryRun?: boolean;
    days?: number;
  } | null;

  const path = body?.path?.trim();
  const serverId = Number(body?.serverId);
  if (!path) return NextResponse.json({ error: 'A database path is required' }, { status: 400 });
  if (!Number.isInteger(serverId) || !(await getServer(serverId))) {
    return NextResponse.json({ error: 'Unknown server' }, { status: 400 });
  }

  const days = Number(body?.days);
  const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : 0;

  try {
    const summary = await importFromTautulli(path, serverId, {
      dryRun: body?.dryRun === true,
      sinceMs,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    // The message names the file the admin typed, which they already know — no path from
    // anywhere else can reach this, so there is nothing here they could not see anyway.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Import failed' },
      { status: 400 },
    );
  }
}
