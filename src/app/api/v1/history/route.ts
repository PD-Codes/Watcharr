import { NextResponse } from 'next/server';
import { desc, eq, gte, and } from 'drizzle-orm';
import { db } from '@/db';
import { users, watchHistory } from '@/db/schema';
import { checkApiKey, daysParam } from '@/server/publicapi';

export const dynamic = 'force-dynamic';

const MAX_LIMIT = 500;

/**
 * Recent plays across every server, newest first. The last piece a dashboard asks for
 * after "what is playing" and "how much was watched".
 */
export async function GET(request: Request) {
  const denied = await checkApiKey(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const days = daysParam(request, 7);
  const requested = Number(params.get('limit'));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_LIMIT, requested) : 100;
  const username = params.get('user');

  const filters = [gte(watchHistory.watchedAt, new Date(Date.now() - days * 86_400_000))];
  if (username) filters.push(eq(users.username, username));

  const rows = await db
    .select({
      user: users.username,
      title: watchHistory.title,
      grandparentTitle: watchHistory.grandparentTitle,
      mediaType: watchHistory.mediaType,
      year: watchHistory.year,
      genres: watchHistory.genres,
      watchedAt: watchHistory.watchedAt,
      durationMs: watchHistory.durationMs,
      deviceName: watchHistory.deviceName,
      // Which writer recorded the play: the media server's own list, a stream this app
      // watched end to end, or an import. Worth exposing — it is the difference between
      // "we know it was played" and "we know how much of it was".
      source: watchHistory.source,
    })
    .from(watchHistory)
    .innerJoin(users, eq(users.id, watchHistory.userId))
    .where(and(...filters))
    .orderBy(desc(watchHistory.watchedAt))
    .limit(limit);

  return NextResponse.json({ days, count: rows.length, plays: rows });
}
