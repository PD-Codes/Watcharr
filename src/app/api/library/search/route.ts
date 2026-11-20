import { NextResponse } from 'next/server';
import { searchVisibleLibrary } from '@/server/library';
import { getSession } from '@/server/session';
import { unauthorized } from '@/server/apierror';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const query = new URL(request.url).searchParams.get('q') ?? '';
  // A user searches the library of the server they signed in through, and only the parts of it
  // the media server shares with them.
  return NextResponse.json({ items: await searchVisibleLibrary(session, query).catch(() => []) });
}
