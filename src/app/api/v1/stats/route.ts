import { NextResponse } from 'next/server';
import {
  getDailyPlays,
  getPlaysByMediaType,
  getTopGenres,
  getTopTitles,
  getTotals,
  getUserLeaderboard,
} from '@/server/stats';
import { checkApiKey, daysParam } from '@/server/publicapi';

export const dynamic = 'force-dynamic';

/**
 * Server-wide aggregates for a dashboard tile. Deployment-wide rather than per server:
 * the key is not a user and has no server of its own, and a numbers panel that silently
 * covered only one of two servers would be worse than one that covers both.
 */
export async function GET(request: Request) {
  const denied = await checkApiKey(request);
  if (denied) return denied;

  const days = daysParam(request);
  const scope = { userId: null } as const;
  const [totals, byType, genres, titles, users, daily] = await Promise.all([
    getTotals(scope, days),
    getPlaysByMediaType(scope, days),
    getTopGenres(scope, 10),
    getTopTitles(scope, 10),
    getUserLeaderboard(undefined, 10),
    getDailyPlays(scope, Math.min(days, 90)),
  ]);

  return NextResponse.json({
    days,
    totals,
    playsByMediaType: byType,
    topGenres: genres,
    topTitles: titles,
    /** Watch time per user, in minutes. */
    topUsers: users,
    dailyPlays: daily,
  });
}
