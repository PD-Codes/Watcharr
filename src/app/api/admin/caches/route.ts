import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { CACHE_ACTIONS, getCacheStats, runCacheAction } from '@/server/caches';
import { getGlobalAdminSession } from '@/server/session';
import { badBody, globalAdminRequired } from '@/server/apierror';

export const dynamic = 'force-dynamic';


/** Current numbers, polled while a refresh runs. */
export async function GET() {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();
  return NextResponse.json(await getCacheStats());
}

export async function POST(request: Request) {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();
  const body = await readBody(request, { action: 'string' });
  const action = CACHE_ACTIONS.find((a) => a === body?.action);
  if (!body || !action) return badBody();
  return NextResponse.json({ ok: true, ...(await runCacheAction(action)), stats: await getCacheStats() });
}
