import { NextResponse } from 'next/server';
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { createAdapter, type ServerType } from '@/server/adapters';
import { listServers } from '@/server/config';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

// Anyone can call this, and every call would ping every media server. A short memory keeps
// a flood of requests from turning into a flood against the media servers.
const CACHE_MS = 10_000;
let cache: { at: number; servers: Awaited<ReturnType<typeof checkServers>> } | null = null;

async function checkServers() {
  const servers = await listServers().catch(() => []);
  // One entry per server; the overall state is the worst of them.
  return Promise.all(
    servers.map(async (server) => ({
      id: server.id,
      slug: server.slug,
      label: server.label,
      ...(await createAdapter(server.serverType as ServerType, server.serverUrl, server.serverToken)
        .ping()
        .catch(() => ({ ok: false }))),
    })),
  );
}

/**
 * Liveness for the container healthcheck, which needs the status code and nothing else.
 * The detail (which server is down, its name and version) is only for signed-in admins —
 * to anyone else it would describe the deployment.
 */
export async function GET() {
  // better-sqlite3 is synchronous, so a failing query throws instead of rejecting.
  let database = true;
  try {
    db.all(sql`SELECT 1`);
  } catch {
    database = false;
  }

  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), servers: await checkServers() };
  const checked = cache.servers;

  const ok = database && checked.every((s) => s.ok);
  const status = ok ? 200 : 503;

  const user = (await getSession().catch(() => null))?.user;
  if (!user || !(user.isAdmin || user.globalAdmin)) return NextResponse.json({ ok }, { status });

  // A server admin sees their own server, a global admin all of them.
  const mediaServers = checked
    .filter((s) => user.globalAdmin || s.id === user.serverId)
    .map(({ id: _id, ...rest }) => rest);
  return NextResponse.json({ ok, database, configured: checked.length > 0, mediaServers }, { status });
}
