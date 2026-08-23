import { NextResponse } from 'next/server';
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { getAdapter, getConfig } from '@/server/config';

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

  const config = await getConfig().catch(() => null);
  const mediaServer = config
    ? await getAdapter()
        .then((a) => a.ping())
        .catch(() => ({ ok: false }))
    : { ok: false };

  const ok = database && (!config || mediaServer.ok);
  return NextResponse.json(
    { ok, database, configured: Boolean(config), mediaServer },
    { status: ok ? 200 : 503 },
  );
}
