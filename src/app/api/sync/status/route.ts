import { NextResponse } from 'next/server';
import { getSession } from '@/server/session';
import { artworkProgress } from '@/server/sync';

export const dynamic = 'force-dynamic';

/** How far the background data loading is. Counts only, so any signed-in user may ask. */
export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ artwork: await artworkProgress() });
}
