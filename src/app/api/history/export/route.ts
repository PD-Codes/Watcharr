import { NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { db } from '@/db';
import { watchHistory } from '@/db/schema';
import { historyFilters } from '@/server/history';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

const MAX_ROWS = 50000;

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /["\n,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  const where = historyFilters(session.user.id, {
    q: sp.get('q') ?? undefined,
    type: sp.get('type') ?? undefined,
    days: sp.get('days') ?? undefined,
    genre: sp.get('genre') ?? undefined,
    date: sp.get('date') ?? undefined,
    weekday: sp.get('weekday') ?? undefined,
    hour: sp.get('hour') ?? undefined,
  });

  const rows = await db
    .select()
    .from(watchHistory)
    .where(where)
    .orderBy(desc(watchHistory.watchedAt))
    .limit(MAX_ROWS);

  const lines = ['Watched,Title,Episode,Type,Year,Genres,Duration (min),Device'];
  for (const row of rows) {
    lines.push(
      [
        row.watchedAt.toISOString(),
        row.grandparentTitle ?? row.title,
        row.grandparentTitle ? row.title : '',
        row.mediaType,
        row.year ?? '',
        row.genres.join('; '),
        Math.round(row.durationMs / 60000),
        row.deviceName ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="watcharr-history.csv"',
    },
  });
}
