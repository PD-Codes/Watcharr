import { NextResponse } from 'next/server';
import { searchLibrary } from '@/server/library';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const query = new URL(request.url).searchParams.get('q') ?? '';
  // A user searches the library of the server they signed in through.
  return NextResponse.json({ items: await searchLibrary(session.user.serverId, query) });
}
