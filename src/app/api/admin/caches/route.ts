import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { CACHE_ACTIONS, getCacheStats, runCacheAction } from '@/server/caches';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

async function allowed() {
  return Boolean((await getSession())?.user.globalAdmin);
}
const denied = () => NextResponse.json({ error: 'Global admin access required' }, { status: 403 });

/** Current numbers, polled while a refresh runs. */
export async function GET() {
  if (!(await allowed())) return denied();
  return NextResponse.json(await getCacheStats());
}

export async function POST(request: Request) {
  if (!(await allowed())) return denied();
  const body = await readBody(request, { action: 'string' });
  const action = CACHE_ACTIONS.find((a) => a === body?.action);
  if (!body || !action) return badBody();
  return NextResponse.json({ ok: true, ...(await runCacheAction(action)), stats: await getCacheStats() });
}
