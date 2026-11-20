import { NextResponse } from 'next/server';
import { getSession } from '@/server/session';
import { artworkProgress } from '@/server/sync';
import { unauthorized } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/** How far the background data loading is. Counts only, so any signed-in user may ask. */
export async function GET() {
  if (!(await getSession())) return unauthorized();
  return NextResponse.json({ artwork: await artworkProgress() });
}
