import { NextResponse } from 'next/server';
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { createAdapter, type ServerType } from '@/server/adapters';
import { listServers } from '@/server/config';

export const dynamic = 'force-dynamic';

/** Liveness plus dependency health, used by the admin page and container healthchecks. */
export async function GET() {
  // better-sqlite3 is synchronous, so a failing query throws instead of rejecting.
  let database = true;
  try {
    db.all(sql`SELECT 1`);
  } catch {
    database = false;
  }

  const servers = await listServers().catch(() => []);
  // One entry per server; the overall state is the worst of them.
  const mediaServers = await Promise.all(
    servers.map(async (server) => ({
      slug: server.slug,
      label: server.label,
      ...(await createAdapter(server.serverType as ServerType, server.serverUrl, server.serverToken)
        .ping()
        .catch(() => ({ ok: false }))),
    })),
  );

  const ok = database && mediaServers.every((s) => s.ok);
  return NextResponse.json(
    { ok, database, configured: servers.length > 0, mediaServers },
    { status: ok ? 200 : 503 },
  );
}
