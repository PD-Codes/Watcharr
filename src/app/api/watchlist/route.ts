import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { watchlist } from '@/db/schema';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

const STATUSES = ['planned', 'watching', 'done'];

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await request.json()) as {
    itemId?: string;
    title?: string;
    mediaType?: string;
    year?: number;
  };
  if (!body.itemId || !body.title) {
    return NextResponse.json({ error: 'itemId and title are required' }, { status: 400 });
  }

  await db
    .insert(watchlist)
    .values({
      userId: session.user.id,
      itemId: body.itemId,
      title: body.title,
      mediaType: body.mediaType ?? 'unknown',
      year: body.year,
    })
    .onConflictDoNothing();
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { itemId, status } = (await request.json()) as { itemId?: string; status?: string };
  if (!itemId || !status || !STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  await db
    .update(watchlist)
    .set({ status })
    .where(and(eq(watchlist.userId, session.user.id), eq(watchlist.itemId, itemId)));
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const itemId = new URL(request.url).searchParams.get('itemId');
  if (!itemId) return NextResponse.json({ error: 'itemId is required' }, { status: 400 });

  await db
    .delete(watchlist)
    .where(and(eq(watchlist.userId, session.user.id), eq(watchlist.itemId, itemId)));
  return NextResponse.json({ ok: true });
}
