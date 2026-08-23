import { NextResponse } from 'next/server';
import { searchLibrary } from '@/server/library';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await getSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const query = new URL(request.url).searchParams.get('q') ?? '';
  return NextResponse.json({ items: await searchLibrary(query) });
}
